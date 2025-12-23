(listing_block
  attributes: (source_block_attributes
    keyword: (source_attribute_keyword)
    language: (source_language) @language)
  content: (block_content) @injection.content
  (#set! injection.language @language)
  (#set! injection.include-children))

(listing_block
  content: (block_content) @injection.content)

(literal_block
  content: (block_content) @injection.content)

(passthrough_block
  content: (block_content) @injection.content)

(asciidoc_blockquote
  content: (block_content) @injection.content)

(open_block
  content: (block_content) @injection.content)

; Inject comment
((comment) @injection.content
  (#set! injection.language "comment"))
