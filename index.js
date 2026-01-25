const express = require('express')
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const mqtt = require('mqtt');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

// Konfigurasi
const BROKER = 'mqtt://ismaillowkey.my.id';
const TOPICSENDFROMMQTT = 'wa/private/send';
const TOPICRECEIVE = 'wa/private/receive';
const PORT = 4000;
var sock;
let isConnected = false;

// Setup CSV Writer
const csvWriter = createCsvWriter({
  path: 'wa2mqtt.csv',
  header: [
    {id: 'number', title: 'NUMBER'},
    {id: 'message', title: 'MESSAGE'},
    {id: 'datetime', title: 'DATETIME'}
  ],
  append: true
});

// MQTT Setup
const mqttClient = mqtt.connect(BROKER);
mqttClient.on('connect', () => {
  console.log(`🔌 MQTT connected to ${BROKER}`);
  mqttClient.subscribe(TOPICSENDFROMMQTT);
});

mqttClient.on('error', (err) => {
  console.error('❌ MQTT connection error:', err);
});

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    //version,
    //version: [2, 3000, 1025190524],
    version: [2, 3000, 1027934701],
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📱 Scan QR code:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      isConnected = true;
      console.log('✅ WhatsApp connected');
    }

    if (connection === 'close') {
      isConnected = false;
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log(`❌ Disconnected. Reason: ${reason}`);
      
      // Cek apakah logged out
      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      console.log(`Should reconnect: ${shouldReconnect}`);
      
      if (shouldReconnect) {
        console.log('🔁 Reconnecting...');
        setTimeout(() => {
          startSock();
        }, 5000);
      } else {
        console.log('🚫 Logged out, please scan QR again');
      }
    }
  });

  // Kirim pesan dari MQTT
  mqttClient.on('message', async (topic, message) => {
    if (topic.toLowerCase() === TOPICSENDFROMMQTT.toLowerCase()) {
      if (!isConnected) {
        console.warn('⚠️ WhatsApp not connected. Message skipped.');
        return;
      }

      try {
        const payload = JSON.parse(message.toString());
        let numberStr = payload.number.toString();
        
        // Format nomor
        if (numberStr.startsWith('0')) {
          numberStr = '62' + numberStr.slice(1);
        } else if (numberStr.startsWith('+62')) {
          numberStr = numberStr.slice(1);
        } else if (numberStr.startsWith('62')) {
          // Sudah benar
        } else {
          numberStr = '62' + numberStr;
        }
        
        const jid = numberStr + '@s.whatsapp.net';
        const text = payload.message;
        
        console.log(`📩 Sending to ${numberStr}: ${text}`);
        await sock.sendMessage(jid, { text });
        
        // Log ke CSV
        try {
          await csvWriter.writeRecords([{
            number: numberStr,
            message: `OUTGOING: ${text}`,
            datetime: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
          }]);
          console.log('✅ Outgoing message logged to CSV');
        } catch (csvErr) {
          console.log('⚠️ Failed to log outgoing to CSV:', csvErr.message);
        }
        
      } catch (err) {
        console.error('❌ Error sending message:', err);
      }
    }
  });

  // Terima pesan masuk
  sock.ev.on('messages.upsert', async (upsert) => {
    if (upsert.type !== 'notify') return;

    for (const msg of upsert.messages) {
      if (msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      if (!jid) continue;
      
      const [numberString, stat] = jid.split('@');
      if (stat !== 's.whatsapp.net') continue;

      const chatWA = msg.message?.extendedTextMessage?.text ?? 
                    msg.message?.conversation ?? 
                    msg.message?.imageMessage?.caption ??
                    msg.message?.videoMessage?.caption ??
                    '[Media tanpa caption]';

      const dateObject = new Date(
        Number(msg.messageTimestamp) * 1000
      ).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

      console.log('----------------------------------');
      console.log('📩 Pesan baru dari:', numberString);
      console.log('💬 Message:', chatWA);
      console.log('🕐 Time:', dateObject);
      console.log('----------------------------------');

      if (chatWA !== undefined) {
        const payload = {
          number: numberString,
          message: chatWA,
          datetime: dateObject
        };

        // Kirim ke MQTT
        mqttClient.publish(TOPICRECEIVE, JSON.stringify(payload));

        const dateTime = new Date().toLocaleString('en-US', {
          timeZone: 'Asia/Jakarta'
        });

        try {
          // Baca pesan
          await sock.readMessages([msg.key]);
          
          // Balas dengan konfirmasi
          const messageSend =
            `[BOT] Pesan telah diterima dan dibaca pada ${dateTime}\n` +
            `📊 Data dikirim ke:\n` +
            `Broker: ${BROKER}\n` +
            `Topic: ${TOPICRECEIVE}\n`;
          
          await sock.sendMessage(jid, { text: messageSend });
        } catch (err) {
          console.log('❌ Error replying:', err.message);
        }

        // Simpan ke CSV
        try {
          await csvWriter.writeRecords([payload]);
          console.log('✅ Incoming message saved to CSV');
        } catch (csvErr) {
          console.log('❌ CSV write error:', csvErr.message);
        }
      }
    }
  });

  // Handle pesan lain
  sock.ev.on('messages.update', (updates) => {
    for (const update of updates) {
      if (update.update?.status) {
        console.log(`📊 Message status update: ${update.update.status} for ${update.key.remoteJid}`);
      }
    }
  });
}

// Start aplikasi
startSock();

const app = express()
app.use(express.json())

app.post(`/api/${TOPICSENDFROMMQTT}`, async (req, res) => {
  if (!isConnected) {
    return res.status(503).json({ error: 'WhatsApp not connected' })
  }

  const body = {
    number: req.body.number,
    message: req.body.message
  }

  let numberStr = body.number
  if (numberStr.startsWith('0')) {
    numberStr = '62' + numberStr.slice(1)
  }

  const jid = numberStr + '@s.whatsapp.net'

  try {
    await sock.sendMessage(jid, { text: body.message })
    res.status(200).json(body)
  } catch (err) {
    console.log('Error sending via API:', err)
    res.status(500).json({ error: 'Failed to send message' })
  }
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on http://0.0.0.0:${PORT}`)
})


// 🔒 Error & Exit Handling
process.on('exit', code => {
  console.log(`Process exited with code: ${code}`);
  mqttClient.end();
});

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  mqttClient.end();
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', err => {
  console.error(`Uncaught Exception: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
