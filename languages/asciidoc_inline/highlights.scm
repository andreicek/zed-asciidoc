; [
;   (monospace)
;   (passthrough)
; ] @markup.raw @nospell

(emphasis) @emphasis.strong

(italic) @emphasis

(highlight) @emphasis

[
  (link_url)
  (email)
] @link_url @link_text

(uri_label) @link_text

[
  "["
  "]"
  "{"
  "}"
  "<<" @punctuation.bracket
  ">>" @punctuation.bracket
] @punctuation.bracket

":" @punctuation.delimiter

(replacement) @string.special

(xref
  (reftext) @link_text @link_uri)

(xref
  (id) @link_text @link_uri .)

(xref
  (id) @link_text
  (reftext) @link_text @link_uri)

[
  (macro_name)
  "((("
  ")))"
  "(("
  "))"
] @keyword

(inline_macro
  (target) @label)

(inline_macro
  (attr) @attribute)

(escaped_sequence) @string.escape

(inline_macro
  (target)? @link_text @link_uri
  (attr)? @label)

; (stem_macro
;   (target)? @label
;   (attr)? @markup.raw @nospell)

(footnote
  (target)? @label
  (attr) @attribute)

(term) @attribute

(id_assignment) @label

(super_escape) @string.special
