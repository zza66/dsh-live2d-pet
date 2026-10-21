// 假 GPT-SoVITS 上游（只为验证适配层）：POST /tts 收 JSON，回一小段真 WAV。
// 用：node tools/fake-gptsovits.mjs [port]
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 9880);

function wav(seconds, hz) {
  const rate = 22050;
  const frames = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + frames * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + frames * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i += 1) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 9000), 44 + i * 2);
  }
  return buf;
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, note: 'fake upstream alive' }));
      return;
    }
    let payload = {};
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* 坏 JSON 当空 */ }
    const text = String(payload.text ?? '');
    if (!text) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'text is required' }));
      return;
    }
    if (payload.ref_audio_path === '') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'ref_audio_path is required' }));
      return;
    }
    const audio = wav(0.6, 520);
    console.log(`[fake] ${text.length} 字 text_lang=${payload.text_lang} speed=${payload.speed_factor} → ${audio.length} B`);
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(audio.length) });
    res.end(audio);
  });
}).listen(port, '127.0.0.1', () => console.log(`fake GPT-SoVITS on http://127.0.0.1:${port}/tts`));
