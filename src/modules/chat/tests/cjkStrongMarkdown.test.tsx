import assert from 'node:assert/strict';
import { render } from '@testing-library/react';
import { test } from 'vitest';

import { Markdown } from '@/modules/chat/transcript/Markdown';

test('renders Chinese bold phrases followed directly by the next sentence', () => {
  const source = '- **先生成草稿。 **接着检查内容。\n- **再核对细节。**最后发布。';
  const { container } = render(<Markdown>{source}</Markdown>);
  assert.deepEqual([...container.querySelectorAll('li strong')].map((node) => node.textContent), [
    '先生成草稿。', '再核对细节。',
  ]);
  assert.deepEqual([...container.querySelectorAll('li')].map((node) => node.textContent), [
    '先生成草稿。 接着检查内容。', '再核对细节。最后发布。',
  ]);
});

test('keeps literal emphasis markers inside code and escaped text', () => {
  const source = '`**代码。**内容`\n\n\\*\\*原文。\\*\\*内容\n\n**标准粗体**正文';
  const { container } = render(<Markdown>{source}</Markdown>);
  assert.equal(container.querySelector('code')?.textContent, '**代码。**内容');
  assert.match(container.textContent ?? '', /\*\*原文。\*\*内容/);
  assert.deepEqual([...container.querySelectorAll('strong')].map((node) => node.textContent), ['标准粗体']);
});
