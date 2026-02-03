((paragraph) @injection.content
  (#set! injection.language "AsciiDoc Inline"))

((line) @injection.content
  (#set! injection.language "AsciiDoc Inline"))

; Inject comment
((line_comment) @injection.content
  (#set! injection.language "comment"))

((block_comment) @injection.content
  (#set! injection.language "comment"))
