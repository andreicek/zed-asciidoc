((paragraph) @injection.content
  (#set! injection.include-children)
  (#set! injection.language "asciidoc_inline"))

((line) @injection.content
  (#set! injection.include-children)
  (#set! injection.language "asciidoc_inline"))

; Inject comment
((line_comment) @injection.content
  (#set! injection.language "comment"))

((block_comment) @injection.content
  (#set! injection.language "comment"))