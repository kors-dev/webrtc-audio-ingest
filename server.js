// server.js (CommonJS)
// Прийом WebRTC-аудіо через mediasoup + автозапис кожного стріму.
// Запис "as-is": OGG/Opus (мінімум CPU), опційна пост-конвертація в MP3.

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const mediasoup = require('mediasoup');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const { spawn } = require('child_process');

const HTTP_PORT    = Number(process.env.PORT || 3000);
const RTP_PORT     = Number(process.env.RTP_PORT || 40000);
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || null;

// Де зберігати файли
const RECORD_DIR = process.env.RECORD_DIR || '/recordings';

// Налаштування запису/конвертації
// Якщо RECORD_FORMAT=mp3 або POST_CONVERT_MP3=true — після завершення OGG робимо MP3.
const RECORD_FORMAT     = (process.env.RECORD_FORMAT || 'ogg').toLowerCase(); // ogg | mp3
const POST_CONVERT_MP3  = /^(1|true)$/i.test(process.env.POST_CONVERT_MP3 || '') || RECORD_FORMAT === 'mp3';
const RECORD_BITRATE    = process.env.RECORD_BITRATE || '160k'; // для mp3 (128k/160k/192k)
const KEEP_OGG          = /^(1|true)$/i.test(process.env.KEEP_OGG || 'true'); // лишати .ogg після конвертації

if (!fs.existsSync(RECORD_DIR)) fs.mkdirSync(RECORD_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let worker, router, webRtcServer;
const transports = new Map(); // transportId -> transport
const producers  = new Map(); // producerId  -> producer
const recordings = new Map(); // producerId  -> { ffmpeg, consumer, transport, file, sdpFile }

// -------------------- mediasoup bootstrap --------------------
async function runMediasoup() {
  worker = await mediasoup.createWorker();
  worker.on('died', () => {
    console.error('mediasoup worker died, exiting');
    process.exit(1);
  });

  const listenInfos = [
    { protocol: 'udp', ip: '0.0.0.0', port: RTP_PORT },
    { protocol: 'tcp', ip: '0.0.0.0', port: RTP_PORT },
  ];
  if (ANNOUNCED_IP) listenInfos.forEach(li => li.announcedIp = ANNOUNCED_IP);

  webRtcServer = await worker.createWebRtcServer({ listenInfos });

  router = await worker.createRouter({
    mediaCodecs: [
      { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
    ],
  });

  console.log(`[mediasoup] router ready; WebRTC UDP/TCP port=${RTP_PORT} announcedIp=${ANNOUNCED_IP || 'n/a'}`);
}

// -------------------- helpers --------------------
function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function getFreeUdpPort() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.on('error', reject);
    sock.bind(0, '127.0.0.1', () => {
      const { port } = sock.address();
      sock.close(() => resolve(port));
    });
  });
}

function buildOpusSdp({ ip, port, payloadType, ssrc }) {
  // RTCP-mux (один порт), recvonly — ffmpeg тільки приймає.
  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=mediasoup-audio',
    `c=IN IP4 ${ip}`,
    't=0 0',
    `m=audio ${port} RTP/AVP ${payloadType}`,
    `a=rtpmap:${payloadType} opus/48000/2`,
    'a=fmtp:' + payloadType + ' sprop-stereo=1;stereo=1;minptime=10;useinbandfec=1',
    'a=rtcp-mux',
    'a=recvonly',
    `a=ssrc:${ssrc} cname:mediasoup-audio`,
    ''
  ].join('\n');
}

function convertOggToMp3(oggFile, bitrate = '160k') {
  return new Promise((resolve) => {
    const mp3File = oggFile.replace(/\.ogg$/i, '.mp3');
    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-i', oggFile,
      '-vn',
      '-c:a', 'libmp3lame',
      '-b:a', bitrate,
      '-ar', '44100', // 44.1 kHz — максимальна сумісність
      '-ac', '2',
      mp3File
    ];
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('exit', (code) => {
      console.log(`[post] mp3 exit code=${code} -> ${mp3File}`);
      if (code === 0 && !KEEP_OGG) {
        try { fs.unlinkSync(oggFile); } catch {}
      }
      resolve();
    });
  });
}

// -------------------- recording pipeline --------------------
async function startRecordingForProducer(producer) {
  try {
    const localIp = '127.0.0.1';
    const rtpPort = await getFreeUdpPort(); // ffmpeg слухатиме тут

    // PlainRtpTransport шле RTP на ffmpeg:rtpPort (rtcp-mux=true => один порт)
    const plainTransport = await router.createPlainTransport({
      listenIp: { ip: localIp },
      rtcpMux: true,
      comedia: false
    });
    await plainTransport.connect({ ip: localIp, port: rtpPort });

    // canConsume за rtpCapabilities роутера
    const rtpCapabilities = router.rtpCapabilities;
    if (!router.canConsume({ producerId: producer.id, rtpCapabilities })) {
      console.warn(`[record] cannot consume producer ${producer.id}`);
      await plainTransport.close();
      return;
    }

    // Consumer на plain-транспорті
    const consumer = await plainTransport.consume({
      producerId: producer.id,
      rtpCapabilities,
      paused: true // спершу стоп — дочекаємось, поки ffmpeg відкриє сокет
    });

    const codec = consumer.rtpParameters.codecs[0];
    const enc   = consumer.rtpParameters.encodings[0];
    const payloadType = codec.payloadType;
    const ssrc        = enc.ssrc;

    const sdpText = buildOpusSdp({ ip: localIp, port: rtpPort, payloadType, ssrc });

    const base    = `${ts()}_peer-${producer.appData?.peerId || 'unknown'}_prod-${producer.id}`;
    const sdpFile = path.join(RECORD_DIR, `${base}.sdp`);
    const outFile = path.join(RECORD_DIR, `${base}.ogg`);
    fs.writeFileSync(sdpFile, sdpText, 'utf-8');

    // ffmpeg: читаємо SDP, пишемо OGG/Opus без транскодування (мінімум CPU)
    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-protocol_whitelist', 'file,udp,rtp',
      '-i', sdpFile,
      '-c', 'copy',
      outFile
    ];
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    ff.on('exit', async (code, signal) => {
    console.log(`[ffmpeg] exit code=${code} signal=${signal} file=${outFile}`);

    // файл існує і має дані?
    let hasData = false;
    try {
        const st = fs.statSync(outFile);
        hasData = st.size > 8192; // >8KB — грубий фільтр від «порожніх» файлів
    } catch {}

    // ffmpeg часто завершується 255 при SIGINT — розглядаємо це як «ок» для пост-конвертації
    const ok = (code === 0 || code === 255 || signal === 'SIGINT' || hasData);

    if (POST_CONVERT_MP3 && ok) {
        try {
        await convertOggToMp3(outFile, RECORD_BITRATE);
        } catch (e) {
        console.error('[post] mp3 convert failed:', e);
        }
    }

    // приберемо тимчасовий SDP
    try { fs.unlinkSync(sdpFile); } catch {}
    });

    // Дамо ffmpeg кілька мс, щоби повністю підняти сокет
    await new Promise(r => setTimeout(r, 150));
    await consumer.resume();

    recordings.set(producer.id, {
      ffmpeg: ff,
      consumer,
      transport: plainTransport,
      file: outFile,
      sdpFile
    });

    console.log(`[record] started for producer=${producer.id} → ${outFile}`);

    // Авто-очистка при закритті
    const cleanup = () => stopRecordingForProducer(producer.id);
    producer.on('transportclose', cleanup);
    producer.on('producerclose',  cleanup);

  } catch (e) {
    console.error('[record] start error:', e);
  }
}

function stopRecordingForProducer(producerId) {
  const rec = recordings.get(producerId);
  if (!rec) return;
  try { rec.consumer?.close(); } catch {}
  try { rec.transport?.close(); } catch {}
  try {
    if (rec.ffmpeg && !rec.ffmpeg.killed) {
      rec.ffmpeg.kill('SIGINT'); // м'яко завершуємо файл
    }
  } catch {}
  recordings.delete(producerId);
  console.log(`[record] stopped for producer=${producerId}`);
}

// -------------------- HTTP API --------------------
app.get('/rtp-capabilities', (req, res) => res.json(router.rtpCapabilities));

app.post('/create-transport', async (req, res) => {
  try {
    const peerId = req.body?.peerId || uuidv4();
    const transport = await router.createWebRtcTransport({
      webRtcServer,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1_000_000,
      appData: { peerId },
    });

    transports.set(transport.id, transport);

    transport.on('dtlsstatechange', (state) => {
      if (state === 'closed' || state === 'failed') {
        transports.delete(transport.id);
        transport.close();
      }
    });

    res.json({
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    });
  } catch (e) {
    console.error('create-transport error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/connect-transport', async (req, res) => {
  const { transportId, dtlsParameters } = req.body || {};
  const transport = transports.get(transportId);
  if (!transport) return res.status(404).json({ error: 'transport not found' });
  await transport.connect({ dtlsParameters });
  res.json({ connected: true });
});

app.post('/produce', async (req, res) => {
  const { transportId, kind, rtpParameters, peerId } = req.body || {};
  const transport = transports.get(transportId);
  if (!transport) return res.status(404).json({ error: 'transport not found' });
  if (kind !== 'audio') return res.status(400).json({ error: 'only audio supported' });

  try {
    const producer = await transport.produce({
      kind,
      rtpParameters,
      appData: { peerId },
    });

    producers.set(producer.id, producer);

    // Автозапис нового стріму
    startRecordingForProducer(producer).catch((e) => console.error('record start failed:', e));

    producer.on('transportclose', () => producers.delete(producer.id));
    producer.on('producerclose',  () => producers.delete(producer.id));

    console.log(`[producer] id=${producer.id} peer=${peerId} kind=${kind}`);
    res.json({ id: producer.id });
  } catch (e) {
    console.error('produce error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/producers', (req, res) => {
  const list = [...producers.values()].map((p) => ({
    id: p.id,
    peerId: p.appData?.peerId,
    kind: p.kind,
    paused: p.paused,
    recordingFile: recordings.get(p.id)?.file || null
  }));
  res.json(list);
});

app.post('/stop-recording', (req, res) => {
  const { producerId } = req.body || {};
  if (!producerId) return res.status(400).json({ error: 'producerId required' });
  stopRecordingForProducer(producerId);
  res.json({ ok: true });
});

// -------------------- start --------------------
(async () => {
  await runMediasoup();
  app.listen(HTTP_PORT, () =>
    console.log(
      `HTTP http://0.0.0.0:${HTTP_PORT}  (WebRTC UDP/TCP on ${RTP_PORT}, records at ${RECORD_DIR}, postMP3=${POST_CONVERT_MP3}, keepOGG=${KEEP_OGG})`
    )
  );
})();
