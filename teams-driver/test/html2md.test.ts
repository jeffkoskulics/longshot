import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown, decodeEntities, escapeMd } from '../src/html2md.ts';

test('decodes entities, including numeric ones', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#39;d&#39; &#x41;'), "a & b <c> 'd' A");
});

test('escapes markdown syntax that appears in ordinary chat text', () => {
  assert.equal(escapeMd('use *args and _kwargs_'), 'use \\*args and \\_kwargs\\_');
});

test('renders inline marks', () => {
  assert.equal(htmlToMarkdown('<p><b>bold</b> and <i>italic</i></p>'), '**bold** and *italic*');
});

test('renders links with their href', () => {
  assert.equal(
    htmlToMarkdown('<p>see <a href="https://example.com/x">this</a></p>'),
    'see [this](https://example.com/x)',
  );
});

test('renders ordered and unordered lists, numbering independently', () => {
  assert.equal(htmlToMarkdown('<ul><li>a</li><li>b</li></ul>'), '- a\n- b');
  assert.equal(htmlToMarkdown('<ol><li>a</li><li>b</li></ol>'), '1. a\n2. b');
});

test('keeps code blocks verbatim, without escaping their contents', () => {
  const md = htmlToMarkdown('<pre>if (a &amp;&amp; b) { *x* }</pre>');
  assert.ok(md.includes('if (a && b) { *x* }'), md);
  assert.ok(md.startsWith('```'), md);
});

test('keeps emoji alt text and drops the transient image src', () => {
  const md = htmlToMarkdown('<p>nice <img alt=":smile:" src="https://cdn/x.png"> one</p>');
  assert.equal(md, 'nice :smile: one');
});

test('unknown tags lose their markup but never their text', () => {
  assert.equal(htmlToMarkdown('<p>hello <mark><span>world</span></mark></p>'), 'hello world');
});

test('a message body that is only whitespace renders as empty, not as junk', () => {
  assert.equal(htmlToMarkdown('<div>  </div><p>\n</p>'), '');
});

test('malformed html does not throw', () => {
  assert.doesNotThrow(() => htmlToMarkdown('<p>unclosed <b>bold <a href="#">link'));
});
