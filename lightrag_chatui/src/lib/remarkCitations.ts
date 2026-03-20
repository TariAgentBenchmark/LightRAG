import { visit } from 'unist-util-visit'
import type { Plugin } from 'unified'
import type { Root, Text } from 'mdast'

const CITATION_PATTERN = /\[(\^?\d+(?:\s*,\s*\d+)*)\]/g

export const remarkCitations: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || typeof index !== 'number') {
        return
      }

      const replacements: Root['children'] = []
      let lastIndex = 0
      let match: RegExpExecArray | null

      while ((match = CITATION_PATTERN.exec(node.value)) !== null) {
        const raw = match[1] ?? ''
        const normalizedIds = raw
          .replace(/^\^/, '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)

        if (normalizedIds.length === 0) {
          continue
        }

        if (match.index > lastIndex) {
          replacements.push({
            type: 'text',
            value: node.value.slice(lastIndex, match.index)
          })
        }

        replacements.push({
          type: 'html',
          value: `<citation-ref data-ids="${normalizedIds.join(',')}"></citation-ref>`
        })

        lastIndex = match.index + match[0].length
      }

      if (replacements.length === 0) {
        return
      }

      if (lastIndex < node.value.length) {
        replacements.push({
          type: 'text',
          value: node.value.slice(lastIndex)
        })
      }

      parent.children.splice(index, 1, ...replacements)
    })
  }
}
