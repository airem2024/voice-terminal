// test-chunker.js — 切句器 + 语音清洗回归测试(0813 自检修复批)
// 跑法:node test-chunker.js;全部断言过 → exit 0
const assert = require('assert');
const { SentenceChunker } = require('./tts');
const { sanitizeSpeech } = require('./core/turn');

// C1 连发标点不再卡死(老代码 "?!" 切出孤 "!" 回炉 → 整轮死锁)
{
  const c = new SentenceChunker();
  const out = [...c.feed('真的吗?!'), ...c.feed('那太好了。后面还有话,'), ...c.feed('继续说。')];
  assert.deepStrictEqual(out, ['真的吗?!', '那太好了。', '后面还有话,继续说。'], 'C1 实际: ' + JSON.stringify(out));
  assert.strictEqual(c.flush().length, 0, 'C1 flush 应为空');
  console.log('C1 连发标点 ✅');
}

// C2 标点开头的流不吞后文(老代码 "。" 回炉后永远堵在队头)
{
  const c = new SentenceChunker();
  const out = [...c.feed('。'), ...c.feed('今天天气不错。明天呢?')];
  assert.deepStrictEqual(out, ['今天天气不错。', '明天呢?'], 'C2 实际: ' + JSON.stringify(out));
  console.log('C2 孤标点开头 ✅');
}

// C3 收尾引号并入本句
{
  const c = new SentenceChunker();
  const out = c.feed('她说:「好。」然后就走了。');
  assert.deepStrictEqual(out, ['她说:「好。」', '然后就走了。'], 'C3 实际: ' + JSON.stringify(out));
  console.log('C3 收尾引号 ✅');
}

// C4 逗号**不许**断句(0815 反转:原先"首句短优先"会在第一个逗号处劈开)
// 用户实听:「"那种人真的无语了"怎么会在"那种人"那里断句呢」。原因是首句攒够 6 字就软切,
// 而那个优化的前提("首句越短出声越快")被实测证伪 —— TTS 首片延迟和文本长度几乎无关。
// 劈开的两半各自起调收调、中间还夹封尾补零,听感就是一顿一顿。这里守住:没有硬标点就不出句。
{
  const c = new SentenceChunker();
  const out = c.feed('碰到那种人,真的无语了');
  assert.deepStrictEqual(out, [], 'C4 没有硬标点时不该切出句子,实际: ' + JSON.stringify(out));
  const done = c.feed('。');
  assert.deepStrictEqual(done, ['碰到那种人,真的无语了。'], 'C4 整句应完整出来,实际: ' + JSON.stringify(done));
  console.log('C4 逗号不断句 ✅ :', done[0]);
}

// C5 mood 泄漏兜底:跨 delta 只会漏出 '⁣[mood' 任意前缀(server 按累积文本找完整标记)
{
  assert.strictEqual(sanitizeSpeech('好呀,晚安。⁣[mood'), '好呀,晚安。');
  assert.strictEqual(sanitizeSpeech('⁣[mo'), '');
  assert.strictEqual(sanitizeSpeech('嗯。[mood] 开心|想念=3'), '嗯。');
  console.log('C5 mood 残片清洗 ✅');
}

// C6 markdown/URL 去噪
{
  assert.strictEqual(sanitizeSpeech('这个**很重要**,看`config.json`就懂'), '这个很重要,看config.json就懂');
  assert(!sanitizeSpeech('文档在 https://example.com/a/b 里').includes('http'), 'C6 URL 应被替换');
  assert(sanitizeSpeech('```js\nconsole.log(1)\n```好了').includes('代码略'), 'C6 代码块应折叠');
  assert.strictEqual(sanitizeSpeech('[点这里](https://x.com)看'), '点这里看');
  console.log('C6 markdown 去噪 ✅');
}

// C7 超长强切仍然生效
{
  const c = new SentenceChunker();
  const out = c.feed('一二三四五六七八九十'.repeat(8) + ',尾巴。');
  assert(out.length >= 1 && out.every((s) => s.length <= 61), 'C7 实际: ' + JSON.stringify(out.map((s) => s.length)));
  console.log('C7 超长强切 ✅');
}

console.log('\n切句器/清洗回归全部通过。');
