require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware для парсинга JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Загрузка данных о городах
const cities = JSON.parse(fs.readFileSync('./cities.json', 'utf8'));

// Импорт бота для отправки уведомлений
let bot, users;
try {
    const botModule = require('./bot.js');
    bot = botModule.bot;
    users = botModule.users;
} catch (err) {
    console.log('⚠️ Бот не загружен, уведомления не будут отправляться');
}

// Функция для парсинга User-Agent
function parseUserAgent(userAgent) {
    let device = 'Неизвестно';
    let browser = 'Неизвестно';

    // Определяем устройство
    if (/mobile/i.test(userAgent)) {
        if (/iphone/i.test(userAgent)) device = 'iPhone';
        else if (/ipad/i.test(userAgent)) device = 'iPad';
        else if (/android/i.test(userAgent)) device = 'Android';
        else device = 'Мобильное';
    } else if (/tablet/i.test(userAgent)) {
        device = 'Планшет';
    } else {
        if (/windows/i.test(userAgent)) device = 'Windows';
        else if (/mac/i.test(userAgent)) device = 'Mac';
        else if (/linux/i.test(userAgent)) device = 'Linux';
        else device = 'Компьютер';
    }

    // Определяем браузер
    if (/edg/i.test(userAgent)) browser = 'Edge';
    else if (/chrome/i.test(userAgent) && !/edg/i.test(userAgent)) browser = 'Chrome';
    else if (/safari/i.test(userAgent) && !/chrome/i.test(userAgent)) browser = 'Safari';
    else if (/firefox/i.test(userAgent)) browser = 'Firefox';
    else if (/opera|opr/i.test(userAgent)) browser = 'Opera';
    else if (/yabrowser/i.test(userAgent)) browser = 'Яндекс.Браузер';

    return { device, browser };
}

// Статические файлы
app.use('/css', express.static('css'));
app.use('/js', express.static('js'));
app.use('/images', express.static('images'));

// Главная страница (Тюмень по умолчанию)
app.get('/', (req, res) => {
    const cityData = cities['tyumen'];
    res.send(generateHTML('tyumen', cityData));
});

// Динамические страницы городов
app.get('/:city', (req, res) => {
    const cityKey = req.params.city.toLowerCase();
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] || 'Неизвестно';

    // Уведомляем создателя ссылки о посещении
    const creatorId = users?.linkCreators?.[cityKey];
    if (bot && creatorId) {
        const cityData = cities[cityKey] || { name: users?.cityNames?.[cityKey] || capitalizeCity(cityKey) };

        // Парсим User-Agent для получения информации о браузере и устройстве
        const deviceInfo = parseUserAgent(userAgent);

        const visitMessage = `👁 Посещение вашей ссылки!\n\n` +
            `🏙 Город: ${cityData.name}\n` +
            `🌐 IP: ${clientIp}\n` +
            `📱 Устройство: ${deviceInfo.device}\n` +
            `🌐 Браузер: ${deviceInfo.browser}\n` +
            `🕐 Время: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`;

        bot.sendMessage(creatorId, visitMessage).catch(err => {
            console.error('Ошибка отправки уведомления о посещении:', err);
        });
    }

    if (cities[cityKey]) {
        // Город есть в базе - используем его данные
        const cityData = cities[cityKey];
        res.send(generateHTML(cityKey, cityData));
    } else {
        // Города нет в базе - используем данные по умолчанию с названием города
        const defaultCity = cities['tyumen'];

        // Получаем оригинальное русское название из сохраненных данных
        const russianName = users?.cityNames?.[cityKey] || capitalizeCity(cityKey);

        const customCityData = {
            ...defaultCity,
            name: russianName,
            address: `г. ${russianName}, уточняйте адрес в Telegram`,
            coordinates: defaultCity.coordinates // Используем координаты по умолчанию
        };
        res.send(generateHTML(cityKey, customCityData));
    }
});

// API endpoint для обработки заявок на бронирование
app.post('/api/booking/:city', (req, res) => {
    const cityKey = req.params.city.toLowerCase();
    const { name, telegram, sauna, comment } = req.body;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // Получаем данные города
    const cityData = cities[cityKey] || { name: users?.cityNames?.[cityKey] || capitalizeCity(cityKey) };

    // Находим создателя ссылки для этого города
    const creatorId = users?.linkCreators?.[cityKey];

    if (bot) {
        const saunaNames = {
            'baikal': 'Байкал',
            'taiga': 'Тайга',
            'banya': 'Русская баня'
        };

        // Уникальный ID заявки для callback
        const bookingId = `${cityKey}_${Date.now()}`;

        // Сохраняем заявку в базе
        if (!users.bookings) users.bookings = {};
        users.bookings[bookingId] = {
            cityKey,
            cityName: cityData.name,
            clientName: name,
            clientTelegram: telegram,
            sauna,
            saunaName: saunaNames[sauna] || sauna,
            comment,
            timestamp: Date.now(),
            takenBy: [],
            status: 'pending',
            completedBy: null
        };

        // Сохраняем изменения
        const fs = require('fs');
        fs.writeFileSync('./users.json', JSON.stringify(users, null, 2));

        // Отправляем уведомление создателю ссылки (воркеру)
        if (creatorId) {
            const workerInfo = users?.workerInfo?.[cityKey];
            const workerName = workerInfo ? workerInfo.name : 'Не указан';

            const creatorMessage = `🔔 *НОВАЯ ЗАЯВКА НА БРОНИРОВАНИЕ!*\n\n` +
                `📍 *Локация:* ${cityData.name}\n` +
                `🏠 *Объект:* Сауна «${saunaNames[sauna] || sauna}»\n` +
                `👤 *Воркер:* ${workerName}`;

            bot.sendMessage(creatorId, creatorMessage, {
                parse_mode: 'Markdown'
            }).catch(err => {
                console.error('Ошибка отправки уведомления создателю:', err);
            });
        }

        // Отправляем заявку в админский чат
        const adminChatId = process.env.ADMIN_CHAT_ID || -3749513674;

        const workerInfo = users?.workerInfo?.[cityKey];
        const workerText = workerInfo ? `👨‍💼 *Работник:* ${workerInfo.name}\n` : '';

        const adminMessage = `🔔 *Новая заявка на бронирование!*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `🏙 *Город:* ${cityData.name}\n` +
            `👤 *Имя:* ${name}\n` +
            `💬 *Telegram:* ${telegram}\n` +
            `🏔 *Сауна:* ${saunaNames[sauna] || sauna}\n` +
            (comment ? `📝 *Комментарий:* ${comment}\n` : '') +
            (workerInfo ? `${workerText}` : '') +
            `\n🔗 *Ссылка:* ${process.env.BASE_URL}/${cityKey}`;

        bot.sendMessage(adminChatId, adminMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '🤝 Взял на отработку', callback_data: `take_${bookingId}` }
                ]]
            }
        }).catch(err => {
            console.error('Ошибка отправки уведомления в админский чат:', err);
        });
    }

    res.json({ success: true, message: 'Заявка принята' });
});

// Функция для капитализации названия города
function capitalizeCity(cityKey) {
    return cityKey
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

// Функция генерации HTML
function generateHTML(cityKey, cityData) {
    let html = fs.readFileSync('./index.html', 'utf8');

    // Замена данных города
    html = html.replace(/г\. Тюмень, ул\. Садовая, 73/g, cityData.address);
    html = html.replace(/@sosalhui/g, cityData.telegram);
    html = html.replace(/Премиальный центр отдыха в Тюмени/g, `Премиальный центр отдыха в ${cityData.name}`);
    html = html.replace(/Душа Сибири — Премиальный центр отдыха в Тюмени/g, `Душа Сибири — Премиальный центр отдыха в ${cityData.name}`);

    // Замена цен (обрабатываем оба формата: с "/час" и без)
    html = html.replace(/3500₽/g, `${cityData.prices.baikal}₽`);
    html = html.replace(/3000₽/g, `${cityData.prices.taiga}₽`);
    html = html.replace(/2500₽/g, `${cityData.prices.banya}₽`);

    // Замена цен в dropdown селекте формы бронирования
    html = html.replace(/Сауна «Байкал» — \d+₽\/час/g, `Сауна «Байкал» — ${cityData.prices.baikal}₽/час`);
    html = html.replace(/Сауна «Тайга» — \d+₽\/час/g, `Сауна «Тайга» — ${cityData.prices.taiga}₽/час`);
    html = html.replace(/Русская баня — \d+₽\/час/g, `Русская баня — ${cityData.prices.banya}₽/час`);

    // Замена координат на карте
    const mapUrl = `https://yandex.ru/map-widget/v1/?ll=${cityData.coordinates.lon}%2C${cityData.coordinates.lat}&z=16&l=map&pt=${cityData.coordinates.lon},${cityData.coordinates.lat},pm2rdm`;
    html = html.replace(/src="https:\/\/yandex\.ru\/map-widget[^"]*"/g, `src="${mapUrl}"`);

    // Инжектим cityKey и цены в HTML для использования в JavaScript
    html = html.replace('</body>', `<script>
        window.CITY_KEY = '${cityKey}';
        window.CITY_PRICES = {
            baikal: ${cityData.prices.baikal},
            taiga: ${cityData.prices.taiga},
            banya: ${cityData.prices.banya}
        };
    </script></body>`);

    return html;
}

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
    console.log(`📍 Доступные города: ${Object.keys(cities).join(', ')}`);
    if (bot) {
        console.log('🤖 Telegram бот интегрирован и готов отправлять уведомления');
    }
});
