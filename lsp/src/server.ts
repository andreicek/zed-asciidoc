import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  CodeActionKind,
  CodeActionParams,
  CodeAction,
  Command,
  ExecuteCommandParams,
  ShowDocumentParams,
  DidChangeConfigurationNotification,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import asciidoctorFactory from "asciidoctor";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const PREVIEW_COMMAND = "asciidoc.previewInBrowser";

type Engine = "tree-sitter" | "asciidoctor-js" | "asciidoctor-d";

type LspSettings = {
  engine: Engine;
  asciidoctorDPath?: string;
};

let settings: LspSettings = {
  engine: "asciidoctor-js",
};

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
// asciidoctor's package typings + NodeNext interop: treat as callable factory.
const asciidoctor = (asciidoctorFactory as unknown as () => {
  convert: (
    input: string,
    options?: Record<string, unknown>,
  ) => string;
})();

connection.onInitialize((_params: InitializeParams) => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.Source],
      },
      executeCommandProvider: {
        commands: [PREVIEW_COMMAND],
      },
      workspace: {
        workspaceFolders: {
          supported: true,
        },
      },
    },
  };
});

connection.onInitialized(async () => {
  connection.client.register(DidChangeConfigurationNotification.type, undefined);
  await refreshSettings();
});

connection.onDidChangeConfiguration(async (change) => {
  applySettingsObject(change.settings);
  await refreshSettings();
});

documents.onDidChangeContent(() => {
  // Preview is on-demand for now.
});

connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc || !isAsciiDoc(doc.uri)) {
    return [];
  }

  return [
    {
      title: "Preview AsciiDoc in browser",
      kind: CodeActionKind.Source,
      command: Command.create(
        "Preview AsciiDoc in browser",
        PREVIEW_COMMAND,
        doc.uri,
      ),
    },
  ];
});

connection.onExecuteCommand(async (params: ExecuteCommandParams) => {
  if (params.command !== PREVIEW_COMMAND) {
    return;
  }

  const uri = params.arguments?.[0];
  if (typeof uri !== "string") {
    connection.window.showErrorMessage(
      "AsciiDoc preview: missing document URI",
    );
    return;
  }

  const doc = documents.get(uri);
  if (!doc) {
    connection.window.showErrorMessage(
      "AsciiDoc preview: document is not open in the language server",
    );
    return;
  }

  try {
    if (settings.engine === "tree-sitter") {
      connection.window.showWarningMessage(
        'AsciiDoc engine is "tree-sitter" (highlighting only). Preview needs "asciidoctor-js" or "asciidoctor-d". Set lsp.asciidoc-lsp.settings.engine in settings.json.',
      );
      return;
    }

    const htmlPath = renderToTempHtml(doc);
    const fileUrl = pathToFileURL(htmlPath).href;
    const showParams: ShowDocumentParams = {
      uri: fileUrl,
      external: true,
      takeFocus: true,
    };
    const result = await connection.window.showDocument(showParams);
    if (!result) {
      connection.window.showWarningMessage(
        "AsciiDoc preview: editor declined to open the browser. Opening may require a newer Zed build with window/showDocument support.",
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    connection.window.showErrorMessage(`AsciiDoc preview failed: ${message}`);
  }
});

async function refreshSettings(): Promise<void> {
  try {
    const cfg = await connection.workspace.getConfiguration([
      { section: "asciidoc-lsp" },
      { section: "asciidoc" },
    ]);
    if (Array.isArray(cfg)) {
      for (const item of cfg) {
        applySettingsObject(item);
      }
    } else {
      applySettingsObject(cfg);
    }
  } catch {
    // Client may not support workspace/configuration; rely on didChangeConfiguration.
  }
}

function applySettingsObject(raw: unknown): void {
  if (!raw || typeof raw !== "object") {
    return;
  }
  const obj = raw as Record<string, unknown>;
  // Zed may send the settings object directly, or nested.
  const candidates = [obj, obj.settings, obj.asciidoc, obj["asciidoc-lsp"]].filter(
    (v) => v && typeof v === "object",
  ) as Record<string, unknown>[];

  for (const next of candidates) {
    if (typeof next.engine === "string") {
      settings.engine = normalizeEngine(next.engine);
    }
    if (typeof next.asciidoctorDPath === "string") {
      settings.asciidoctorDPath = next.asciidoctorDPath;
    }
  }
}

function normalizeEngine(value: string): Engine {
  if (
    value === "tree-sitter" ||
    value === "asciidoctor-js" ||
    value === "asciidoctor-d"
  ) {
    return value;
  }
  return "asciidoctor-js";
}

function isAsciiDoc(uri: string): boolean {
  const lower = uri.toLowerCase();
  return lower.endsWith(".adoc") || lower.endsWith(".asciidoc");
}

function renderToTempHtml(doc: TextDocument): string {
  const sourcePath = uriToFsPath(doc.uri);
  const baseDir = sourcePath ? dirname(sourcePath) : process.cwd();
  const hash = createHash("sha1").update(doc.uri).digest("hex").slice(0, 12);
  const outDir = join(tmpdir(), "zed-asciidoc-preview");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${hash}.html`);

  if (settings.engine === "asciidoctor-d") {
    return renderWithAsciidoctorD(doc, baseDir, outPath);
  }

  const html = asciidoctor.convert(doc.getText(), {
    safe: "safe",
    standalone: true,
    backend: "html5",
    attributes: {
      "source-highlighter": "highlight.js",
      icons: "font",
    },
    base_dir: baseDir,
  }) as string;

  writeFileSync(outPath, html, "utf8");
  return outPath;
}

function renderWithAsciidoctorD(
  doc: TextDocument,
  baseDir: string,
  outPath: string,
): string {
  const bin = resolveAsciidoctorD();
  const srcPath = join(
    tmpdir(),
    "zed-asciidoc-preview",
    `src-${Date.now()}.adoc`,
  );
  writeFileSync(srcPath, doc.getText(), "utf8");

  const result = spawnSync(bin, ["-o", outPath, srcPath], {
    cwd: baseDir,
    encoding: "utf8",
  });

  if (result.error) {
    throw new Error(
      `Failed to run asciidoctor-d (${bin}): ${result.error.message}. Install it or set lsp.asciidoc-lsp.settings.asciidoctorDPath.`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `asciidoctor-d exited ${result.status}: ${result.stderr || result.stdout}`,
    );
  }
  if (!existsSync(outPath)) {
    throw new Error("asciidoctor-d did not write the expected HTML file");
  }
  return outPath;
}

function resolveAsciidoctorD(): string {
  if (settings.asciidoctorDPath && existsSync(settings.asciidoctorDPath)) {
    return settings.asciidoctorDPath;
  }
  const which = process.platform === "win32" ? "where" : "which";
  const probe = spawnSync(which, ["asciidoctor-d"], { encoding: "utf8" });
  const line = (probe.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  if (line && existsSync(line)) {
    return line;
  }
  throw new Error(
    'engine is "asciidoctor-d" but asciidoctor-d was not found on PATH. Download a release from dlang-supplemental/asciidoctor-d or set asciidoctorDPath.',
  );
}

function uriToFsPath(uri: string): string | undefined {
  try {
    if (uri.startsWith("file:")) {
      return fileURLToPath(uri);
    }
  } catch {
    // ignore
  }
  return undefined;
}

documents.listen(connection);
connection.listen();
