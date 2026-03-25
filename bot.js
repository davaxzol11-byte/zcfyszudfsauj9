require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const token = process.env.BOT_TOKEN;
const baseUrl = process.env.BASE_URL || 'https://sibirbanya.site';

// Если bot.js запущен напрямую — включаем polling.
// Если bot.js импортируется (например, из server.js) — polling выключаем,
// иначе будет 409 Conflict (два getUpdates запроса одновременно).
const bot = new TelegramBot(token, { polling: require.main === module });

// Загрузка данных о городах и пользователях
const CITIES_FILE = path.join(__dirname, 'cities.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const cities = JSON.parse(fs.readFileSync(CITIES_FILE, 'utf8'));
let users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));

// Инициализация структур данных
if (!users.workerStats) users.workerStats = {};
if (!users.bookings) users.bookings = {};
if (!users.banned) users.banned = [];
if (!users.cityReservations) users.cityReservations = {};
if (!users.linkCreators) users.linkCreators = {};
if (!users.broadcastSettings) users.broadcastSettings = {
    trainingLink: 'https://t.me/your_training_channel',
    rulesLink: 'https://t.me/your_rules_channel',
    paymentsLink: 'https://t.me/your_payments_channel',
    chatLink: 'https://t.me/your_workers_chat'
};

// Если bot.js запущен отдельным процессом (polling=true),
// а сайт (server.js) крутится отдельным процессом и пишет users.json,
// то в этом процессе данные будут "устаревать".
// Это приводит к ошибке "анкеты/заявки нет" при нажатии inline-кнопок.
// Поэтому подхватываем изменения users.json и обновляем объект in-place,
// чтобы сохранялась ссылка на экспортируемый users.
fs.watchFile(USERS_FILE, { interval: 1000 }, () => {
    try {
        const fresh = JSON.parse(fs.readFileSync('./users.json', 'utf8'));
        for (const k of Object.keys(users)) delete users[k];
        Object.assign(users, fresh);
    } catch (e) {
        console.error('Ошибка авто-перезагрузки users.json:', e);
    }
});

// Сохранение данных пользователей
function saveUsers() {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Получить или создать статистику работника
function getWorkerStats(userId) {
    if (!users.workerStats[userId]) {
        users.workerStats[userId] = {
            total: 0,
            completed: 0,
            failed: 0
        };
    }
    return users.workerStats[userId];
}

// Проверка доступа пользователя
function hasAccess(userId) {
    if (users.banned && users.banned.includes(userId)) return false;
    return users.admins.includes(userId) || users.whitelist.includes(userId);
}

// Проверка, является ли пользователь админом
function isAdmin(userId) {
    return users.admins.includes(userId);
}

// Проверка резервации города
function isCityReserved(cityKey, userId) {
    if (!users.cityReservations) users.cityReservations = {};
    const reservation = users.cityReservations[cityKey];

    if (!reservation) return false;

    // Проверяем, не истекла ли резервация (24 часа)
    const now = Date.now();
    const expiryTime = 24 * 60 * 60 * 1000; // 24 часа

    if (now - reservation.timestamp > expiryTime) {
        // Резервация истекла, удаляем её
        delete users.cityReservations[cityKey];
        saveUsers();
        return false;
    }

    // Город зарезервирован другим пользователем
    return reservation.userId !== userId;
}

// Получить количество зарезервированных городов для пользователя
function getUserReservedCitiesCount(userId) {
    if (!users.cityReservations) return 0;

    let count = 0;
    const now = Date.now();
    const expiryTime = 24 * 60 * 60 * 1000;

    for (const [cityKey, reservation] of Object.entries(users.cityReservations)) {
        if (reservation.userId === userId) {
            // Проверяем, не истекла ли резервация
            if (now - reservation.timestamp <= expiryTime) {
                count++;
            } else {
                // Удаляем истекшую резервацию
                delete users.cityReservations[cityKey];
            }
        }
    }

    saveUsers();
    return count;
}

// Зарезервировать город
function reserveCity(cityKey, userId, cityName) {
    if (!users.cityReservations) users.cityReservations = {};

    users.cityReservations[cityKey] = {
        userId: userId,
        cityName: cityName,
        timestamp: Date.now()
    };

    saveUsers();
}

// Создать ссылку для пользователя с кастомными или дефолтными данными
function createLinkForUser(userId, tempData, customPrices, customAddress, chatId, messageId) {
    const { cityKey, cityName, cityData } = tempData;

    // Используем кастомные цены или дефолтные
    const finalPrices = customPrices || cityData.prices;

    // Используем кастомный адрес или дефолтный
    const finalAddress = customAddress || cityData.address;

    // Сохраняем кастомные данные для этого города
    if (!users.customCityData) users.customCityData = {};
    users.customCityData[cityKey] = {
        prices: finalPrices,
        address: finalAddress
    };

    const url = `${baseUrl}/${cityKey}`;

    // Сохраняем создателя ссылки для этого города
    users.linkCreators[cityKey] = userId;

    // Сохраняем оригинальное русское название города
    if (!users.cityNames) users.cityNames = {};
    users.cityNames[cityKey] = cityName;

    // Сохраняем информацию о работнике (создателе ссылки)
    if (!users.workerInfo) users.workerInfo = {};
    const workerName = users.customTags?.[userId] ? `#${users.customTags[userId]}` : `ID: ${userId}`;
    users.workerInfo[cityKey] = {
        userId: userId,
        name: workerName,
        timestamp: Date.now()
    };

    // Очищаем временные данные
    delete users.tempLinkData[userId];
    delete users.userStates[userId];
    saveUsers();

    // Проверяем, является ли URL публичным
    const isPublicUrl = !baseUrl.includes('localhost') && !baseUrl.includes('127.0.0.1');

    const message = `✅ *ССЫЛКА СОЗДАНА!*\n\n` +
        `🏙 *Город:* ${cityName}\n` +
        `📍 *Адрес:* ${finalAddress}\n` +
        `💬 *Telegram:* ${cityData.telegram}\n\n` +
        `💰 *Цены:*\n` +
        `• Байкал: ${finalPrices.baikal}₽/час\n` +
        `• Тайга: ${finalPrices.taiga}₽/час\n` +
        `• Русская баня: ${finalPrices.banya}₽/час\n\n` +
        `🔗 *Ваша персональная ссылка:*\n${url}\n\n` +
        `⏰ *Город зарезервирован на 24 часа*\n\n` +
        `📊 Вы будете получать уведомления о всех заявках с этой ссылки.`;

    if (messageId) {
        // Если есть messageId, редактируем существующее сообщение
        bot.editMessageText(message, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: isPublicUrl ? {
                inline_keyboard: [[
                    { text: '🌐 Открыть сайт', url: url }
                ]]
            } : undefined
        }).catch(err => {
            console.error('Ошибка редактирования сообщения:', err);
            // Если не удалось отредактировать, отправляем новое
            bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: isPublicUrl ? {
                    inline_keyboard: [[
                        { text: '🌐 Открыть сайт', url: url }
                    ]]
                } : undefined
            });
        });
    } else {
        // Отправляем новое сообщение
        bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: isPublicUrl ? {
                inline_keyboard: [[
                    { text: '🌐 Открыть сайт', url: url }
                ]]
            } : undefined
        });
    }
}

// Команда /start
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Сбрасываем состояние ожидания города при старте
    if (users.userStates && users.userStates[userId]) {
        delete users.userStates[userId];
        saveUsers();
    }

    // Проверка доступа
    if (!hasAccess(userId)) {
        // Проверяем, есть ли уже заявка
        if (users.pending.includes(userId)) {
            bot.sendMessage(chatId, '⏳ Ваша заявка на рассмотрении. Ожидайте одобрения администратора.');
        } else {
            // Начинаем процесс подачи заявки
            if (!users.userStates) users.userStates = {};
            users.userStates[userId] = 'waiting_for_application_source';
            saveUsers();

            bot.sendMessage(chatId,
                `📝 *ЗАЯВКА НА ДОСТУП*\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `Для получения доступа ответьте на несколько вопросов:\n\n` +
                `1️⃣ *Откуда вы узнали о нашей команде?*\n\n` +
                `_Напишите ваш ответ:_`,
                { parse_mode: 'Markdown' }
            );
        }
        return;
    }

    const welcomeMessage = `🌿 *BANSHIK TEAM* — Твой новый уровень профитов.\n\n` +
        `Мы создали идеальную экосистему для комфортной работы. Самые сочные чеки, моментальные выплаты и поддержка, которая не спит.\n\n` +
        `Твоя ссылка — твое оружие. Пора делать кэш.`;

    const keyboard = isAdmin(userId) ? {
        inline_keyboard: [
            [{ text: '👤 Личный кабинет', callback_data: 'show_profile' }],
            [{ text: '⚙️ Настройки бота', callback_data: 'bot_settings' }],
            [{ text: '🔗 Сгенерировать линк', callback_data: 'create_link' }],
            [{ text: '📚 Мануалы & Инфо', callback_data: 'worker_info' }],
            [{ text: '🆘 Саппорт (24/7)', callback_data: 'support' }],
            [{ text: '⚙️ Админ-панель', callback_data: 'admin_panel' }]
        ]
    } : {
        inline_keyboard: [
            [{ text: '👤 Личный кабинет', callback_data: 'show_profile' }],
            [{ text: '⚙️ Настройки бота', callback_data: 'bot_settings' }],
            [{ text: '🔗 Сгенерировать линк', callback_data: 'create_link' }],
            [{ text: '📚 Мануалы & Инфо', callback_data: 'worker_info' }],
            [{ text: '🆘 Саппорт (24/7)', callback_data: 'support' }]
        ]
    };

    bot.sendPhoto(chatId, fs.createReadStream('./images/menu-not-found.jpg'), {
        caption: welcomeMessage,
        parse_mode: 'Markdown',
        reply_markup: keyboard
    }).catch(err => {
        console.error('Ошибка отправки меню:', err);
    });
});

// Команда /pending - список заявок
bot.onText(/\/pending/, (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Эта команда доступна только администраторам.');
        return;
    }

    if (users.pending.length === 0) {
        bot.sendMessage(chatId, '📭 Нет заявок на рассмотрении.');
        return;
    }

    let message = '📋 Заявки на рассмотрении:\n\n';
    users.pending.forEach((pendingUserId, index) => {
        message += `${index + 1}. ID: ${pendingUserId}\n`;
        message += `/approve ${pendingUserId} | /reject ${pendingUserId}\n\n`;
    });

    bot.sendMessage(chatId, message);
});

// Команда /approve - одобрить пользователя
bot.onText(/\/approve (\d+)/, (msg, match) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const targetUserId = parseInt(match[1]);

    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Эта команда доступна только администраторам.');
        return;
    }

    const pendingIndex = users.pending.indexOf(targetUserId);
    if (pendingIndex === -1) {
        bot.sendMessage(chatId, '❌ Пользователь не найден в списке заявок.');
        return;
    }

    // Удаляем из pending и добавляем в whitelist
    users.pending.splice(pendingIndex, 1);
    users.whitelist.push(targetUserId);
    saveUsers();

    bot.sendMessage(chatId, `✅ Пользователь ${targetUserId} одобрен!`);
    bot.sendMessage(targetUserId, '✅ Ваша заявка одобрена! Используйте /start для начала работы.');
});

// Команда /reject - отклонить заявку
bot.onText(/\/reject (\d+)/, (msg, match) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const targetUserId = parseInt(match[1]);

    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Эта команда доступна только администраторам.');
        return;
    }

    const pendingIndex = users.pending.indexOf(targetUserId);
    if (pendingIndex === -1) {
        bot.sendMessage(chatId, '❌ Пользователь не найден в списке заявок.');
        return;
    }

    users.pending.splice(pendingIndex, 1);
    saveUsers();

    bot.sendMessage(chatId, `❌ Заявка пользователя ${targetUserId} отклонена.`);
    bot.sendMessage(targetUserId, '❌ Ваша заявка отклонена.');
});

// Команда /ban - забанить пользователя
bot.onText(/\/ban (\d+)/, (msg, match) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const targetUserId = parseInt(match[1]);

    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Эта команда доступна только администраторам.');
        return;
    }

    if (users.admins.includes(targetUserId)) {
        bot.sendMessage(chatId, '❌ Нельзя забанить администратора.');
        return;
    }

    if (users.banned.includes(targetUserId)) {
        bot.sendMessage(chatId, '⚠️ Пользователь уже забанен.');
        return;
    }

    // Удаляем из whitelist если есть
    const whitelistIndex = users.whitelist.indexOf(targetUserId);
    if (whitelistIndex !== -1) {
        users.whitelist.splice(whitelistIndex, 1);
    }

    // Удаляем из pending если есть
    const pendingIndex = users.pending.indexOf(targetUserId);
    if (pendingIndex !== -1) {
        users.pending.splice(pendingIndex, 1);
    }

    // Добавляем в banned
    users.banned.push(targetUserId);
    saveUsers();

    bot.sendMessage(chatId, `🚫 Пользователь ${targetUserId} забанен.`);
    bot.sendMessage(targetUserId, '🚫 Вы были заблокированы администратором.').catch(() => {});
});

// Команда /unban - разбанить пользователя
bot.onText(/\/unban (\d+)/, (msg, match) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const targetUserId = parseInt(match[1]);

    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Эта команда доступна только администраторам.');
        return;
    }

    const bannedIndex = users.banned.indexOf(targetUserId);
    if (bannedIndex === -1) {
        bot.sendMessage(chatId, '❌ Пользователь не найден в списке забаненных.');
        return;
    }

    users.banned.splice(bannedIndex, 1);
    saveUsers();

    bot.sendMessage(chatId, `✅ Пользователь ${targetUserId} разбанен.`);
    bot.sendMessage(targetUserId, '✅ Вы были разблокированы. Используйте /start для продолжения работы.').catch(() => {});
});

// Команда /broadcast - рассылка всем работникам
bot.onText(/\/broadcast (.+)/, (msg, match) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const message = match[1];

    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Эта команда доступна только администраторам.');
        return;
    }

    let successCount = 0;
    let failCount = 0;

    bot.sendMessage(chatId, '📢 Начинаю рассылку...');

    users.whitelist.forEach(workerId => {
        bot.sendMessage(workerId, `📢 *ОБЪЯВЛЕНИЕ*\n\n${message}`, { parse_mode: 'Markdown' })
            .then(() => successCount++)
            .catch(() => failCount++)
            .finally(() => {
                if (successCount + failCount === users.whitelist.length) {
                    bot.sendMessage(chatId,
                        `✅ Рассылка завершена!\n\n` +
                        `✅ Доставлено: ${successCount}\n` +
                        `❌ Не доставлено: ${failCount}`
                    );
                }
            });
    });
});

// Команда /stats - общая статистика
bot.onText(/\/stats/, (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Эта команда доступна только администраторам.');
        return;
    }

    let totalBookings = 0;
    let completedBookings = 0;
    let failedBookings = 0;
    let pendingBookings = 0;

    Object.values(users.bookings || {}).forEach(booking => {
        totalBookings++;
        if (booking.status === 'completed') completedBookings++;
        else if (booking.status === 'failed') failedBookings++;
        else if (booking.status === 'pending') pendingBookings++;
    });

    const totalWorkers = users.whitelist.length;
    const totalRevenue = completedBookings * 500;

    const statsMessage = `📊 *СТАТИСТИКА*\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👥 *Пользователи:*\n` +
        `• Админов: ${users.admins.length}\n` +
        `• Работников: ${totalWorkers}\n` +
        `• Забанено: ${users.banned.length}\n` +
        `• Заявок на доступ: ${users.pending.length}\n\n` +
        `📋 *Заявки:*\n` +
        `• Всего: ${totalBookings}\n` +
        `• Оплачено: ${completedBookings}\n` +
        `• Не оплачено: ${failedBookings}\n` +
        `• В ожидании: ${pendingBookings}\n\n` +
        `💰 *Доход:*\n` +
        `• Общий: ${totalRevenue}₽`;

    bot.sendMessage(chatId, statsMessage, { parse_mode: 'Markdown' });
});

// Команда /approve_withdrawal - одобрить вывод
bot.onText(/\/approve_withdrawal (.+)/, (msg, match) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const withdrawalId = match[1];

    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Эта команда доступна только администраторам.');
        return;
    }

    if (!users.withdrawalRequests) users.withdrawalRequests = [];

    const request = users.withdrawalRequests.find(r => r.id === withdrawalId);

    if (!request) {
        bot.sendMessage(chatId, '❌ Заявка не найдена.');
        return;
    }

    if (request.status !== 'pending') {
        bot.sendMessage(chatId, '❌ Заявка уже обработана.');
        return;
    }

    request.status = 'approved';
    request.approvedBy = userId;
    request.approvedAt = Date.now();

    if (!users.balances) users.balances = {};
    if (!users.balances[request.userId]) {
        users.balances[request.userId] = { available: 0, totalEarned: 0 };
    }
    users.balances[request.userId].available -= request.amount;

    saveUsers();

    bot.sendMessage(chatId, `✅ Заявка на вывод одобрена!\n\nВоркер: #${request.customTag}\nСумма: ${request.amount.toLocaleString('ru-RU')}₽`);

    bot.sendMessage(request.userId,
        `✅ *Ваша заявка на вывод одобрена!*\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💰 *Сумма:* ${request.amount.toLocaleString('ru-RU')}₽\n\n` +
        `Средства будут переведены в ближайшее время.`,
        { parse_mode: 'Markdown' }
    ).catch(err => console.error('Ошибка уведомления воркера:', err));
});

// Команда /reject_withdrawal - отклонить вывод
bot.onText(/\/reject_withdrawal (.+)/, (msg, match) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const withdrawalId = match[1];

    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Эта команда доступна только администраторам.');
        return;
    }

    if (!users.withdrawalRequests) users.withdrawalRequests = [];

    const request = users.withdrawalRequests.find(r => r.id === withdrawalId);

    if (!request) {
        bot.sendMessage(chatId, '❌ Заявка не найдена.');
        return;
    }

    if (request.status !== 'pending') {
        bot.sendMessage(chatId, '❌ Заявка уже обработана.');
        return;
    }

    request.status = 'rejected';
    request.rejectedBy = userId;
    request.rejectedAt = Date.now();

    saveUsers();

    bot.sendMessage(chatId, `❌ Заявка на вывод отклонена.\n\nВоркер: #${request.customTag}\nСумма: ${request.amount.toLocaleString('ru-RU')}₽`);

    bot.sendMessage(request.userId,
        `❌ *Ваша заявка на вывод отклонена*\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💰 *Сумма:* ${request.amount.toLocaleString('ru-RU')}₽\n\n` +
        `Обратитесь к администратору для уточнения причины.`,
        { parse_mode: 'Markdown' }
    ).catch(err => console.error('Ошибка уведомления воркера:', err));
});

// Команда /setlink - установить ссылки для воркеров
bot.onText(/\/setlink (training|rules|payments|chat) (.+)/, (msg, match) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const linkType = match[1];
    const url = match[2];

    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Эта команда доступна только администраторам.');
        return;
    }

    const linkNames = {
        'training': 'Обучение / Мануалы',
        'rules': 'Правила',
        'payments': 'Выплаты / Чеки',
        'chat': 'Чат воркеров'
    };

    const linkKeys = {
        'training': 'trainingLink',
        'rules': 'rulesLink',
        'payments': 'paymentsLink',
        'chat': 'chatLink'
    };

    users.broadcastSettings[linkKeys[linkType]] = url;
    saveUsers();

    bot.sendMessage(chatId,
        `✅ Ссылка обновлена!\n\n` +
        `📚 ${linkNames[linkType]}\n` +
        `🔗 ${url}`
    );
});

// Команда /admin - открыть админ панель
bot.onText(/\/admin/, (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Эта команда доступна только администраторам.');
        return;
    }

    const adminMessage = `⚙️ *УПРАВЛЕНИЕ*\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `Выберите раздел для управления:`;

    bot.sendMessage(chatId, adminMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '📋 Заявки на доступ', callback_data: 'show_pending' }],
                [{ text: '👥 Пользователи', callback_data: 'manage_users' }],
                [{ text: '📊 Статистика', callback_data: 'show_stats' }],
                [{ text: '📦 Все заявки', callback_data: 'show_all_bookings' }],
                [{ text: '🏆 Топ воркеров', callback_data: 'show_top_workers' }],
                [{ text: '📢 Рассылка', callback_data: 'broadcast_menu' }],
                [{ text: '💰 Управление ценами', callback_data: 'manage_prices' }],
                [{ text: '⚙️ Настройки', callback_data: 'admin_settings' }]
            ]
        }
    });
});

// Команда /profile - профиль и статистика работника
bot.onText(/\/profile/, (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (!hasAccess(userId)) {
        bot.sendMessage(chatId, '❌ У вас нет доступа к боту. Используйте /start для подачи заявки.');
        return;
    }

    const stats = getWorkerStats(userId);
    const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;

    // Получаем дату регистрации (если нет, используем текущую дату)
    if (!users.registrationDates) users.registrationDates = {};
    if (!users.registrationDates[userId]) {
        const now = new Date();
        users.registrationDates[userId] = now.toISOString();
        saveUsers();
    }

    const regDate = new Date(users.registrationDates[userId]);
    const formattedDate = `${String(regDate.getHours()).padStart(2, '0')}:${String(regDate.getMinutes()).padStart(2, '0')} ${String(regDate.getDate()).padStart(2, '0')}.${String(regDate.getMonth() + 1).padStart(2, '0')}.${regDate.getFullYear()}`;

    // Получаем баланс
    if (!users.balances) users.balances = {};
    if (!users.balances[userId]) {
        users.balances[userId] = { available: 0, totalEarned: 0 };
    }
    const balance = users.balances[userId];
    const availableBalance = balance.available || 0;

    const profileMessage = `🏔 *Главное меню*\n\n` +
        `🆔 *Ваш ID:* ${userId}\n` +
        `🏷 *Ваш тэг:* ${username}\n` +
        `📅 *Дата регистрации:* ${formattedDate}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💰 *Сумма профитов:* ${stats.completed * 500}₽\n` +
        `💳 *К выплате:* ${availableBalance.toLocaleString('ru-RU')} ₽`;

    bot.sendMessage(chatId, profileMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🔄 Обновить', callback_data: 'show_profile' },
                    { text: '🏠 Главное меню', callback_data: 'main_menu' }
                ]
            ]
        }
    });
});

// Обработка callback кнопок
bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;
    const userId = query.from.id;
    const userName = query.from.username ? `@${query.from.username}` : query.from.first_name;

    // Сохраняем username для поиска пользователей по @username
    if (!users.usernames) users.usernames = {};
    if (query.from.username) {
        users.usernames[userId] = query.from.username;
        saveUsers();
    }

    // Главное меню
    if (data === 'main_menu') {
        // Сбрасываем состояние ожидания города
        if (users.userStates && users.userStates[userId]) {
            delete users.userStates[userId];
            saveUsers();
        }

        const welcomeMessage = `🌿 *BANSHIK TEAM* — Твой новый уровень профитов.\n\n` +
            `Мы создали идеальную экосистему для комфортной работы. Самые сочные чеки, моментальные выплаты и поддержка, которая не спит.\n\n` +
            `Твоя ссылка — твое оружие. Пора делать кэш.`;

        const keyboard = isAdmin(userId) ? {
            inline_keyboard: [
                [{ text: '👤 Личный кабинет', callback_data: 'show_profile' }],
                [{ text: '⚙️ Настройки бота', callback_data: 'bot_settings' }],
                [{ text: '🔗 Сгенерировать линк', callback_data: 'create_link' }],
                [{ text: '📚 Мануалы & Инфо', callback_data: 'worker_info' }],
                [{ text: '🆘 Саппорт (24/7)', callback_data: 'support' }],
                [{ text: '⚙️ Админ-панель', callback_data: 'admin_panel' }]
            ]
        } : {
            inline_keyboard: [
                [{ text: '👤 Личный кабинет', callback_data: 'show_profile' }],
                [{ text: '⚙️ Настройки бота', callback_data: 'bot_settings' }],
                [{ text: '🔗 Сгенерировать линк', callback_data: 'create_link' }],
                [{ text: '📚 Мануалы & Инфо', callback_data: 'worker_info' }],
                [{ text: '🆘 Саппорт (24/7)', callback_data: 'support' }]
            ]
        };

        // Удаляем старое сообщение и отправляем новое
        bot.deleteMessage(chatId, messageId).catch(() => {});
        bot.sendPhoto(chatId, fs.createReadStream('./images/menu-not-found.jpg'), {
            caption: welcomeMessage,
            parse_mode: 'Markdown',
            reply_markup: keyboard
        }).catch(err => console.error('Ошибка отправки меню:', err));

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Панель управления (только для админов)
    if (data === 'admin_panel') {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        const adminMessage = `⚙️ *УПРАВЛЕНИЕ*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `Выберите раздел для управления:`;

        // Удаляем старое сообщение и отправляем новое
        bot.deleteMessage(chatId, messageId).catch(() => {});
        bot.sendMessage(chatId, adminMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔍 Найти воркера', callback_data: 'search_worker' }],
                    [{ text: '🗺 Резервации городов', callback_data: 'show_reservations' }],
                    [{ text: '💸 Заявки на вывод', callback_data: 'show_withdrawals' }],
                    [{ text: '📋 Заявки на доступ', callback_data: 'show_pending' }],
                    [{ text: '👥 Пользователи', callback_data: 'manage_users' }],
                    [{ text: '📊 Статистика', callback_data: 'show_stats' }],
                    [{ text: '📦 Все заявки', callback_data: 'show_all_bookings' }],
                    [{ text: '🏆 Топ воркеров', callback_data: 'show_top_workers' }],
                    [{ text: '📢 Рассылка', callback_data: 'broadcast_menu' }],
                    [{ text: '💰 Управление ценами', callback_data: 'manage_prices' }],
                    [{ text: '⚙️ Настройки', callback_data: 'admin_settings' }],
                    [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                ]
            }
        }).catch(err => console.error('Ошибка:', err));

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Создать ссылку
    if (data === 'create_link') {
        // Устанавливаем состояние ожидания города
        if (!users.userStates) users.userStates = {};
        users.userStates[userId] = 'waiting_for_city';
        saveUsers();

        const linkMessage = `🔗 *ГЕНЕРАЦИЯ ССЫЛКИ*\n\n` +
            `Чтобы создать персональный домен под сауну, просто отправь название города ответным сообщением.\n\n` +
            `📍 *Популярные сейчас:* Москва, Питер, Казань\n` +
            `⚡️ *Статус системы:* Домены активны, прокси настроены.\n\n` +
            `🔔 Все переходы и заявки будут моментально приходить тебе в личку.`;

        // Удаляем фото и отправляем текст
        bot.deleteMessage(chatId, messageId).catch(() => {});
        bot.sendMessage(chatId, linkMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                ]
            }
        });

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Настройки бота
    if (data === 'bot_settings') {
        // Сбрасываем состояние
        if (users.userStates && users.userStates[userId]) {
            delete users.userStates[userId];
            saveUsers();
        }

        const settingsMessage = `⚙️ *НАСТРОЙКИ БОТА*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `Управление вашими настройками:`;

        bot.deleteMessage(chatId, messageId).catch(() => {});
        bot.sendMessage(chatId, settingsMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🏙 Мои города', callback_data: 'my_cities' }],
                    [{ text: '✏️ Изменить тэг', callback_data: 'change_tag' }],
                    [{ text: '🔔 Уведомления', callback_data: 'notification_settings' }],
                    [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                ]
            }
        });

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Саппорт
    if (data === 'support') {
        // Сбрасываем состояние
        if (users.userStates && users.userStates[userId]) {
            delete users.userStates[userId];
            saveUsers();
        }

        const supportMessage = `🆘 *САППОРТ (24/7)*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `Нужна помощь? Мы всегда на связи!\n\n` +
            `💬 Напишите администратору:\n` +
            `@SibirbanyaVitya\n\n` +
            `⏰ Среднее время ответа: 5-15 минут`;

        bot.deleteMessage(chatId, messageId).catch(() => {});
        bot.sendMessage(chatId, supportMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '💬 Написать в Telegram', url: 'https://t.me/SibirbanyaVitya' }],
                    [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                ]
            }
        });

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Настройки уведомлений
    if (data === 'notification_settings') {
        const notifMessage = `🔔 *НАСТРОЙКИ УВЕДОМЛЕНИЙ*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `Управление уведомлениями:\n\n` +
            `✅ Уведомления о посещениях\n` +
            `✅ Уведомления о заявках\n` +
            `✅ Уведомления о профитах\n\n` +
            `💡 _Скоро появится возможность настройки_`;

        bot.deleteMessage(chatId, messageId).catch(() => {});
        bot.sendMessage(chatId, notifMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '⚙️ Настройки бота', callback_data: 'bot_settings' }],
                    [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                ]
            }
        });

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Показать профиль
    if (data === 'show_profile') {
        // Сбрасываем состояние ожидания города
        if (users.userStates && users.userStates[userId]) {
            delete users.userStates[userId];
            saveUsers();
        }

        const stats = getWorkerStats(userId);

        // Инициализируем пользовательские теги
        if (!users.customTags) users.customTags = {};
        if (!users.customTags[userId]) {
            // Генерируем уникальный тег с 6-значным числом
            const randomNum = Math.floor(100000 + Math.random() * 900000);
            users.customTags[userId] = `banshik-${randomNum}`;
            saveUsers();
        }

        // Инициализируем балансы
        if (!users.balances) users.balances = {};
        if (!users.balances[userId]) {
            users.balances[userId] = {
                available: 0,
                totalEarned: 0
            };
        }

        // Получаем дату регистрации
        if (!users.registrationDates) users.registrationDates = {};
        if (!users.registrationDates[userId]) {
            const now = new Date();
            users.registrationDates[userId] = now.toISOString();
            saveUsers();
        }

        const regDate = new Date(users.registrationDates[userId]);
        const formattedDate = `${String(regDate.getHours()).padStart(2, '0')}:${String(regDate.getMinutes()).padStart(2, '0')} ${String(regDate.getDate()).padStart(2, '0')}.${String(regDate.getMonth() + 1).padStart(2, '0')}.${regDate.getFullYear()}`;

        const customTag = users.customTags[userId];
        const balance = users.balances[userId];
        const availableBalance = balance.available || stats.totalEarned || 0;

        const profileMessage = `🏔 *Главное меню*\n\n` +
            `📇 *Ваш ID:* ${userId}\n` +
            `📇 *Ваш тэг:* #${customTag}\n` +
            `📅 *Дата регистрации:* ${formattedDate}\n` +
            `💸 *Доступно к выводу:* ${availableBalance.toLocaleString('ru-RU')}₽`;

        // Удаляем старое сообщение и отправляем фото с профилем
        bot.deleteMessage(chatId, messageId).catch(() => {});
        bot.sendPhoto(chatId, fs.createReadStream('./images/profil.jpg'), {
            caption: profileMessage,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '📊 Статистика', callback_data: 'show_detailed_stats' },
                        { text: '🔄 Обновить', callback_data: 'show_profile' }
                    ],
                    [
                        { text: '💰 Запросить вывод', callback_data: 'request_withdrawal' },
                        { text: '✏️ Изменить тэг', callback_data: 'change_tag' }
                    ],
                    [
                        { text: '🏠 Главное меню', callback_data: 'main_menu' }
                    ]
                ]
            }
        }).catch(err => {
            console.error('Ошибка отправки фото профиля:', err);
        });

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Показать детальную статистику
    if (data === 'show_detailed_stats') {
        const stats = getWorkerStats(userId);

        // Получаем последнюю активность
        let lastActivity = 'Нет данных';
        const userBookings = Object.values(users.bookings || {}).filter(b =>
            b.takenBy && b.takenBy.some(w => w.userId === userId)
        );

        if (userBookings.length > 0) {
            const lastBooking = userBookings[userBookings.length - 1];
            const lastDate = new Date(lastBooking.timestamp);
            const now = new Date();
            const diffHours = Math.floor((now - lastDate) / (1000 * 60 * 60));

            if (diffHours < 1) {
                lastActivity = 'Только что';
            } else if (diffHours < 24) {
                lastActivity = `Сегодня в ${String(lastDate.getHours()).padStart(2, '0')}:${String(lastDate.getMinutes()).padStart(2, '0')}`;
            } else if (diffHours < 48) {
                lastActivity = 'Вчера';
            } else {
                lastActivity = `${String(lastDate.getDate()).padStart(2, '0')}.${String(lastDate.getMonth() + 1).padStart(2, '0')}.${lastDate.getFullYear()}`;
            }
        }

        const totalEarned = stats.totalEarned || 0;
        const completed = stats.completed || 0;
        const avgCheck = completed > 0 ? Math.round(totalEarned / completed) : 0;

        // Получаем баланс
        if (!users.balances) users.balances = {};
        if (!users.balances[userId]) {
            users.balances[userId] = { available: 0, totalEarned: 0 };
        }
        const balance = users.balances[userId];
        const availableBalance = balance.available || 0;

        const statsMessage = `📊 *Статистика за всё время:*\n\n` +
            `💰 *Сумма профитов:* ${totalEarned.toLocaleString('ru-RU')}₽\n` +
            `💳 *К выплате:* ${availableBalance.toLocaleString('ru-RU')} ₽\n` +
            `📈 *Средний чек:* ${avgCheck.toLocaleString('ru-RU')}₽\n\n` +
            `🕒 *Последняя активность:* ${lastActivity}`;

        bot.editMessageCaption(statsMessage, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔙 Назад к профилю', callback_data: 'show_profile' }],
                    [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                ]
            }
        }).catch(err => console.error('Ошибка:', err));

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Изменить тэг
    if (data === 'change_tag') {
        if (!users.userStates) users.userStates = {};
        users.userStates[userId] = 'waiting_for_new_tag';
        saveUsers();

        bot.deleteMessage(chatId, messageId).catch(() => {});
        bot.sendMessage(chatId,
            `✏️ *ИЗМЕНИТЬ ТЭГ*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `Введите новый тэг (только латиница, цифры и дефис):\n\n` +
            `💡 _Пример: banshik-pro, worker-123_`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '❌ Отмена', callback_data: 'show_profile' }]
                    ]
                }
            }
        );

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Запросить вывод
    if (data === 'request_withdrawal') {
        const stats = getWorkerStats(userId);
        const balance = users.balances?.[userId];
        const availableBalance = balance?.available || stats.totalEarned || 0;

        if (availableBalance < 500) {
            bot.answerCallbackQuery(query.id, {
                text: '❌ Минимальная сумма для вывода: 500₽',
                show_alert: true
            });
            return;
        }

        if (!users.userStates) users.userStates = {};
        users.userStates[userId] = 'waiting_for_withdrawal_amount';
        saveUsers();

        bot.deleteMessage(chatId, messageId).catch(() => {});
        bot.sendMessage(chatId,
            `💰 *ЗАПРОС НА ВЫВОД*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `💸 *Доступно:* ${availableBalance.toLocaleString('ru-RU')}₽\n\n` +
            `Введите сумму для вывода (минимум 500₽):`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💸 Вывести всё', callback_data: `withdraw_all_${availableBalance}` }],
                        [{ text: '❌ Отмена', callback_data: 'show_profile' }]
                    ]
                }
            }
        );

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Вывести всё
    if (data.startsWith('withdraw_all_')) {
        const amount = parseInt(data.replace('withdraw_all_', ''));

        // Создаем заявку на вывод
        if (!users.withdrawalRequests) users.withdrawalRequests = [];

        const withdrawalId = `withdrawal_${userId}_${Date.now()}`;
        users.withdrawalRequests.push({
            id: withdrawalId,
            userId,
            userName: query.from.username ? `@${query.from.username}` : query.from.first_name,
            customTag: users.customTags?.[userId] || 'unknown',
            amount,
            status: 'pending',
            timestamp: Date.now()
        });

        saveUsers();

        bot.deleteMessage(chatId, messageId).catch(() => {});
        bot.sendMessage(chatId,
            `✅ *Заявка на вывод создана!*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `💰 *Сумма:* ${amount.toLocaleString('ru-RU')}₽\n` +
            `⏳ *Статус:* Ожидает обработки\n\n` +
            `Администратор обработает вашу заявку в ближайшее время.`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                    ]
                }
            }
        );

        // Уведомляем админов
        users.admins.forEach(adminId => {
            const realUsername = query.from.username ? `@${query.from.username}` : 'Нет username';
            bot.sendMessage(adminId,
                `💰 *НОВАЯ ЗАЯВКА НА ВЫВОД*\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `👤 *Воркер:* #${users.customTags?.[userId] || userId}\n` +
                `👤 *Username:* ${realUsername}\n` +
                `💵 *Сумма:* ${amount.toLocaleString('ru-RU')}₽\n` +
                `📇 *ID:* ${userId}`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '✅ Одобрить', callback_data: `approve_withdrawal_${withdrawalId}` },
                                { text: '❌ Отклонить', callback_data: `reject_withdrawal_${withdrawalId}` }
                            ]
                        ]
                    }
                }
            ).catch(err => console.error('Ошибка уведомления админа:', err));
        });

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Мои города
    if (data === 'my_cities') {
        // Сбрасываем состояние
        if (users.userStates && users.userStates[userId]) {
            delete users.userStates[userId];
            saveUsers();
        }

        // Получаем зарезервированные города пользователя
        const userCities = [];
        const now = Date.now();
        const expiryTime = 24 * 60 * 60 * 1000;

        if (users.cityReservations) {
            for (const [cityKey, reservation] of Object.entries(users.cityReservations)) {
                if (reservation.userId === userId) {
                    const timeLeft = expiryTime - (now - reservation.timestamp);
                    if (timeLeft > 0) {
                        const hoursLeft = Math.floor(timeLeft / (60 * 60 * 1000));
                        const minutesLeft = Math.floor((timeLeft % (60 * 60 * 1000)) / (60 * 1000));

                        // Получаем статистику по городу
                        const cityVisits = users.cityVisits?.[cityKey] || 0;
                        const cityBookings = Object.values(users.bookings || {}).filter(b => b.cityKey === cityKey).length;

                        userCities.push({
                            cityKey,
                            cityName: reservation.cityName,
                            hoursLeft,
                            minutesLeft,
                            visits: cityVisits,
                            bookings: cityBookings
                        });
                    }
                }
            }
        }

        if (userCities.length === 0) {
            bot.deleteMessage(chatId, messageId).catch(() => {});
            bot.sendMessage(chatId,
                `🏙 *МОИ ГОРОДА*\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `У вас нет зарезервированных городов.\n\n` +
                `Нажмите "📝 Создать ссылку" для резервации города.`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '📝 Создать ссылку', callback_data: 'create_link' }],
                            [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                        ]
                    }
                }
            );
        } else {
            let message = `🏙 *МОИ ГОРОДА*\n\n━━━━━━━━━━━━━━━━━━━━\n\n`;
            const buttons = [];

            userCities.forEach((city, index) => {
                message += `${index + 1}. *${city.cityName}*\n`;
                message += `⏰ Осталось: ${city.hoursLeft}ч ${city.minutesLeft}м\n`;
                message += `👁 Посещений: ${city.visits} | 📋 Заявок: ${city.bookings}\n`;
                message += `🔗 ${baseUrl}/${city.cityKey}\n\n`;

                buttons.push([{ text: `🗑 Освободить ${city.cityName}`, callback_data: `release_city_${city.cityKey}` }]);
            });

            message += `\n💡 _Максимум городов: ${userCities.length}/3_`;

            buttons.push([{ text: '🔄 Обновить', callback_data: 'my_cities' }]);
            buttons.push([{ text: '🏠 Главное меню', callback_data: 'main_menu' }]);

            bot.deleteMessage(chatId, messageId).catch(() => {});
            bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            });
        }

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Освободить город
    if (data.startsWith('release_city_')) {
        const cityKey = data.replace('release_city_', '');
        const reservation = users.cityReservations?.[cityKey];

        if (!reservation || reservation.userId !== userId) {
            bot.answerCallbackQuery(query.id, { text: '❌ Город не найден' });
            return;
        }

        // Удаляем резервацию
        delete users.cityReservations[cityKey];
        delete users.linkCreators[cityKey];
        delete users.customCityData?.[cityKey];
        saveUsers();

        bot.answerCallbackQuery(query.id, { text: '✅ Город освобожден' });

        // Обновляем список городов
        bot.emit('callback_query', { ...query, data: 'my_cities' });
        return;
    }

    // Поиск воркера (админ)
    if (data === 'search_worker') {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        users.userStates[userId] = 'waiting_for_worker_search';
        saveUsers();

        bot.deleteMessage(chatId, messageId).catch(() => {});
        bot.sendMessage(chatId,
            `🔍 *ПОИСК ВОРКЕРА*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `Введите ID или тэг воркера:\n\n` +
            `💡 _Примеры: 123456789, banshik-123_`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '❌ Отмена', callback_data: 'admin_panel' }]
                    ]
                }
            }
        );

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Поиск пользователя (админ)
    if (data === 'search_user') {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        if (!users.userStates) users.userStates = {};
        users.userStates[userId] = 'waiting_for_user_search';
        saveUsers();

        bot.deleteMessage(chatId, messageId).catch(() => {});
        bot.sendMessage(chatId,
            `🔎 *ПОИСК ПОЛЬЗОВАТЕЛЯ*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `Введите ID / @username / #tag:\n\n` +
            `💡 _Примеры:_\n` +
            `• \`7482384212\`\n` +
            `• \`@username\`\n` +
            `• \`#banshik-237114\`` ,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '❌ Отмена', callback_data: 'manage_users' }]
                    ]
                }
            }
        );

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Показать резервации (админ)
    if (data === 'show_reservations') {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        const now = Date.now();
        const expiryTime = 24 * 60 * 60 * 1000;
        const activeReservations = [];

        if (users.cityReservations) {
            for (const [cityKey, reservation] of Object.entries(users.cityReservations)) {
                const timeLeft = expiryTime - (now - reservation.timestamp);
                if (timeLeft > 0) {
                    const hoursLeft = Math.floor(timeLeft / (60 * 60 * 1000));
                    const workerInfo = users.workerInfo?.[cityKey];
                    const workerTag = users.customTags?.[reservation.userId] || reservation.userId;

                    activeReservations.push({
                        cityName: reservation.cityName,
                        cityKey,
                        workerTag,
                        workerName: workerInfo?.name || 'Неизвестен',
                        hoursLeft
                    });
                }
            }
        }

        if (activeReservations.length === 0) {
            bot.editMessageText(
                `🗺 *РЕЗЕРВАЦИИ ГОРОДОВ*\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `Нет активных резерваций.`,
                {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '⚙️ Управление', callback_data: 'admin_panel' }],
                            [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                        ]
                    }
                }
            );
        } else {
            let message = `🗺 *РЕЗЕРВАЦИИ ГОРОДОВ*\n\n━━━━━━━━━━━━━━━━━━━━\n\n`;
            const buttons = [];

            activeReservations.forEach((res, index) => {
                message += `${index + 1}. *${res.cityName}*\n`;
                message += `👤 Воркер: #${res.workerTag}\n`;
                message += `⏰ Осталось: ~${res.hoursLeft}ч\n`;
                message += `🔗 ${baseUrl}/${res.cityKey}\n\n`;

                buttons.push([{ text: `🗑 Освободить ${res.cityName}`, callback_data: `admin_release_${res.cityKey}` }]);
            });

            message += `\n📊 Всего резерваций: ${activeReservations.length}`;

            buttons.push([{ text: '🔄 Обновить', callback_data: 'show_reservations' }]);
            buttons.push([{ text: '⚙️ Управление', callback_data: 'admin_panel' }]);

            bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            });
        }

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Админ освобождает город
    if (data.startsWith('admin_release_')) {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        const cityKey = data.replace('admin_release_', '');
        const reservation = users.cityReservations?.[cityKey];

        if (!reservation) {
            bot.answerCallbackQuery(query.id, { text: '❌ Резервация не найдена' });
            return;
        }

        const workerUserId = reservation.userId;

        // Удаляем резервацию
        delete users.cityReservations[cityKey];
        delete users.linkCreators[cityKey];
        delete users.customCityData?.[cityKey];
        saveUsers();

        // Уведомляем воркера
        bot.sendMessage(workerUserId,
            `⚠️ *Резервация города освобождена*\n\n` +
            `🏙 Город: ${reservation.cityName}\n` +
            `👤 Освободил: Администратор`,
            { parse_mode: 'Markdown' }
        ).catch(err => console.error('Ошибка уведомления воркера:', err));

        bot.answerCallbackQuery(query.id, { text: '✅ Город освобожден' });

        // Обновляем список резерваций
        bot.emit('callback_query', { ...query, data: 'show_reservations' });
        return;
    }

    // Toggle доступ (whitelist)
    if (data.startsWith('toggle_access_')) {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        const targetUserId = parseInt(data.replace('toggle_access_', ''));
        if (!users.whitelist) users.whitelist = [];

        if (users.whitelist.includes(targetUserId)) {
            users.whitelist = users.whitelist.filter(id => id !== targetUserId);
            saveUsers();
            bot.answerCallbackQuery(query.id, { text: '✅ Доступ убран' });
        } else {
            users.whitelist.push(targetUserId);
            saveUsers();
            bot.answerCallbackQuery(query.id, { text: '✅ Доступ выдан' });
        }

        // Обновляем карточку
        if (users.userStates?.[userId]?.state === 'editing_user') {
            bot.sendMessage(chatId, '🔄 Обновлено. Нажмите “🔎 Новый поиск” чтобы посмотреть актуально.');
        }
        return;
    }

    // Toggle бан
    if (data.startsWith('toggle_ban_')) {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        const targetUserId = parseInt(data.replace('toggle_ban_', ''));
        if (!users.banned) users.banned = [];

        if (users.banned.includes(targetUserId)) {
            users.banned = users.banned.filter(id => id !== targetUserId);
            saveUsers();
            bot.answerCallbackQuery(query.id, { text: '✅ Разбанен' });
        } else {
            users.banned.push(targetUserId);
            // на всякий случай убираем из whitelist
            if (users.whitelist) users.whitelist = users.whitelist.filter(id => id !== targetUserId);
            saveUsers();
            bot.answerCallbackQuery(query.id, { text: '✅ Забанен' });
        }

        if (users.userStates?.[userId]?.state === 'editing_user') {
            bot.sendMessage(chatId, '🔄 Обновлено. Нажмите “🔎 Новый поиск” чтобы посмотреть актуально.');
        }
        return;
    }

    // Админ меняет тэг
    if (data.startsWith('admin_change_tag_')) {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        const targetUserId = parseInt(data.replace('admin_change_tag_', ''));
        if (!users.userStates) users.userStates = {};
        users.userStates[userId] = { state: 'waiting_for_admin_new_tag', targetUserId };
        saveUsers();

        bot.deleteMessage(chatId, messageId).catch(() => {});
        bot.sendMessage(chatId,
            `🏷 *ИЗМЕНИТЬ ТЭГ ПОЛЬЗОВАТЕЛЯ*\n\n` +
            `ID: \`${targetUserId}\`\n\n` +
            `Введите новый тэг (латиница/цифры/дефис):`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '❌ Отмена', callback_data: 'manage_users' }]
                    ]
                }
            }
        );

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Админ меняет баланс
    if (data.startsWith('admin_set_balance_')) {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        const targetUserId = parseInt(data.replace('admin_set_balance_', ''));
        if (!users.userStates) users.userStates = {};
        users.userStates[userId] = { state: 'waiting_for_admin_new_balance', targetUserId };
        saveUsers();

        bot.deleteMessage(chatId, messageId).catch(() => {});
        bot.sendMessage(chatId,
            `💰 *ИЗМЕНИТЬ БАЛАНС*\n\n` +
            `ID: \`${targetUserId}\`\n\n` +
            `Введите новую сумму “К выплате” (число):`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '❌ Отмена', callback_data: 'manage_users' }]
                    ]
                }
            }
        );

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Показать помощь
    if (data === 'show_help') {
        // Сбрасываем состояние ожидания города
        if (users.userStates && users.userStates[userId]) {
            delete users.userStates[userId];
            saveUsers();
        }

        const helpMessage = isAdmin(userId)
            ? `❓ *СПРАВКА*\n\n` +
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `📝 *Как работать:*\n\n` +
              `• Создайте ссылку для города\n` +
              `• Делитесь ссылкой с клиентами\n` +
              `• Получайте уведомления о заявках\n` +
              `• Админы обрабатывают заявки\n\n` +
              `⚙️ *Админ-панель:*\n` +
              `Все функции доступны через кнопки в меню "⚙️ Управление"`
            : `❓ *СПРАВКА*\n\n` +
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `📝 *Как работать:*\n\n` +
              `• Создайте ссылку для города\n` +
              `• Делитесь ссылкой с клиентами\n` +
              `• Получайте уведомления о заявках\n` +
              `• Админы обрабатывают заявки\n\n` +
              `🏙 *Мои города:*\n` +
              `Просматривайте свои зарезервированные города, статистику посещений и заявок.\n\n` +
              `💡 *Резервация:*\n` +
              `• Город резервируется на 24 часа\n` +
              `• Максимум 3 города одновременно\n` +
              `• Можно освободить досрочно`;
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `📝 *Как работать:*\n\n` +
              `1️⃣ Напишите название города\n` +
              `2️⃣ Получите персональную ссылку\n` +
              `3️⃣ Делитесь ссылкой с клиентами\n` +
              `4️⃣ Получайте уведомления о заявках\n` +
              `5️⃣ Отслеживайте статистику в профиле\n\n` +
              `💡 _Все заявки с вашей ссылки приходят вам_`;

        // Удаляем фото и отправляем текст
        bot.deleteMessage(chatId, messageId).catch(() => {});
        bot.sendMessage(chatId, helpMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                ]
            }
        });

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Информация для воркеров
    if (data === 'worker_info') {
        const infoMessage = `ℹ️ *ИНФОРМАЦИЯ*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `Полезные ссылки для работы:`;

        bot.deleteMessage(chatId, messageId).catch(() => {});
        bot.sendMessage(chatId, infoMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📚 Обучение / Мануалы', url: users.broadcastSettings.trainingLink }],
                    [{ text: '⚖️ Правила', url: users.broadcastSettings.rulesLink }],
                    [{ text: '💳 Выплаты / Чеки', url: users.broadcastSettings.paymentsLink }],
                    [{ text: '💬 Чат воркеров', url: users.broadcastSettings.chatLink }],
                    [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                ]
            }
        });

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Статистика (админ)
    if (data === 'show_stats') {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        let totalBookings = 0;
        let completedBookings = 0;
        let failedBookings = 0;
        let pendingBookings = 0;
        let totalRevenue = 0;

        Object.values(users.bookings || {}).forEach(booking => {
            totalBookings++;
            if (booking.status === 'completed') {
                completedBookings++;
                totalRevenue += booking.amount || 0;
            }
            else if (booking.status === 'failed') failedBookings++;
            else if (booking.status === 'pending') pendingBookings++;
        });

        const totalWorkers = users.whitelist.length;

        const statsMessage = `📊 *СТАТИСТИКА*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `👥 *Пользователи:*\n` +
            `• Админов: ${users.admins.length}\n` +
            `• Работников: ${totalWorkers}\n` +
            `• Забанено: ${users.banned.length}\n` +
            `• Заявок на доступ: ${users.pending.length}\n\n` +
            `📋 *Заявки:*\n` +
            `• Всего: ${totalBookings}\n` +
            `• Оплачено: ${completedBookings}\n` +
            `• Не оплачено: ${failedBookings}\n` +
            `• В ожидании: ${pendingBookings}\n\n` +
            `💰 *Доход:*\n` +
            `• Общий: ${totalRevenue}₽`;

        bot.editMessageText(statsMessage, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔄 Обновить', callback_data: 'show_stats' }],
                    [{ text: '⚙️ Управление', callback_data: 'admin_panel' }],
                    [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                ]
            }
        }).catch(err => console.error('Ошибка:', err));

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Меню рассылки
    if (data === 'broadcast_menu') {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        const broadcastMessage = `📢 *РАССЫЛКА*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `Отправьте сообщение для рассылки всем работникам.\n\n` +
            `Используйте команду:\n` +
            `\`/broadcast [текст]\`\n\n` +
            `💡 _Сообщение получат все работники из whitelist_`;

        bot.editMessageText(broadcastMessage, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '⚙️ Управление', callback_data: 'admin_panel' }],
                    [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                ]
            }
        }).catch(err => console.error('Ошибка:', err));

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Настройки админа
    if (data === 'admin_settings') {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        const settingsMessage = `⚙️ *НАСТРОЙКИ*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📚 *Обучение:* ${users.broadcastSettings.trainingLink}\n` +
            `⚖️ *Правила:* ${users.broadcastSettings.rulesLink}\n` +
            `💳 *Выплаты:* ${users.broadcastSettings.paymentsLink}\n` +
            `💬 *Чат:* ${users.broadcastSettings.chatLink}\n\n` +
            `Для изменения используйте команды:\n` +
            `\`/setlink training [URL]\`\n` +
            `\`/setlink rules [URL]\`\n` +
            `\`/setlink payments [URL]\`\n` +
            `\`/setlink chat [URL]\``;

        bot.editMessageText(settingsMessage, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '⚙️ Управление', callback_data: 'admin_panel' }],
                    [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                ]
            }
        }).catch(err => console.error('Ошибка:', err));

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Управление ценами
    if (data === 'manage_prices') {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        const pricesMessage = `💰 *УПРАВЛЕНИЕ ЦЕНАМИ*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📝 *Команды:*\n\n` +
            `\`/prices [город]\` - посмотреть цены\n` +
            `_Пример: /prices москва_\n\n` +
            `\`/setprice [город] [сауна] [цена]\`\n` +
            `_Пример: /setprice москва baikal 5500_\n\n` +
            `🏔 *Типы саун:*\n` +
            `• \`baikal\` - Байкал\n` +
            `• \`taiga\` - Тайга\n` +
            `• \`banya\` - Русская баня`;

        bot.editMessageText(pricesMessage, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '⚙️ Управление', callback_data: 'admin_panel' }],
                    [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                ]
            }
        }).catch(err => console.error('Ошибка показа управления ценами:', err));

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Управление пользователями
    if (data === 'manage_users') {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        const usersMessage = `👥 *ПОЛЬЗОВАТЕЛИ*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📊 *Статистика:*\n\n` +
            `• Админов: ${users.admins.length}\n` +
            `• Работников: ${users.whitelist.length}\n` +
            `• Забанено: ${users.banned.length}\n` +
            `• Заявок: ${users.pending.length}`;

        bot.editMessageText(usersMessage, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔎 Поиск пользователя', callback_data: 'search_user' }],
                    [{ text: '📋 Заявки', callback_data: 'show_pending' }],
                    [{ text: '🚫 Забаненные', callback_data: 'show_banned' }],
                    [{ text: '👮 Добавить модератора', callback_data: 'add_moderator' }],
                    [{ text: '👮 Список модераторов', callback_data: 'show_moderators' }],
                    [{ text: '⚙️ Управление', callback_data: 'admin_panel' }],
                    [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                ]
            }
        }).catch(err => console.error('Ошибка показа управления пользователями:', err));

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Показать заявки на вывод
    if (data === 'show_withdrawals') {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        const pendingWithdrawals = users.withdrawalRequests?.filter(w => w.status === 'pending') || [];

        if (pendingWithdrawals.length === 0) {
            bot.editMessageText(
                `💸 *ЗАЯВКИ НА ВЫВОД*\n\n━━━━━━━━━━━━━━━━━━━━\n\n📭 _Нет заявок на рассмотрении_`,
                {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔄 Обновить', callback_data: 'show_withdrawals' }],
                            [{ text: '⚙️ Управление', callback_data: 'admin_panel' }],
                            [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                        ]
                    }
                }
            ).catch(err => console.error('Ошибка:', err));
        } else {
            let message = `💸 *ЗАЯВКИ НА ВЫВОД*\n\n━━━━━━━━━━━━━━━━━━━━\n\n`;

            pendingWithdrawals.forEach((withdrawal, index) => {
                const date = new Date(withdrawal.timestamp);
                const dateStr = `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}`;

                message += `${index + 1}. *#${withdrawal.customTag}*\n`;
                message += `👤 ${withdrawal.userName}\n`;
                message += `💰 ${withdrawal.amount.toLocaleString('ru-RU')}₽\n`;
                message += `📅 ${dateStr}\n\n`;
            });

            // Создаем кнопки для каждой заявки
            const buttons = pendingWithdrawals.map((withdrawal, index) => [
                { text: `✅ Одобрить #${index + 1}`, callback_data: `approve_withdrawal_${withdrawal.id}` },
                { text: `❌ Отклонить #${index + 1}`, callback_data: `reject_withdrawal_${withdrawal.id}` }
            ]);

            buttons.push([{ text: '🔄 Обновить', callback_data: 'show_withdrawals' }]);
            buttons.push([{ text: '⚙️ Управление', callback_data: 'admin_panel' }]);
            buttons.push([{ text: '🏠 Главное меню', callback_data: 'main_menu' }]);

            bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: buttons
                }
            }).catch(err => console.error('Ошибка:', err));
        }

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Добавить модератора
    if (data === 'add_moderator') {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        if (!users.userStates) users.userStates = {};
        users.userStates[userId] = 'waiting_for_moderator_id';
        saveUsers();

        bot.deleteMessage(chatId, messageId).catch(() => {});
        bot.sendMessage(chatId,
            `👮 *ДОБАВИТЬ МОДЕРАТОРА*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `Введите Telegram ID пользователя, которого хотите сделать модератором:\n\n` +
            `💡 _Модератор получит доступ к админ-панели_`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '❌ Отмена', callback_data: 'manage_users' }]
                    ]
                }
            }
        );

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Показать модераторов
    if (data === 'show_moderators') {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        if (users.admins.length === 0) {
            bot.editMessageText(
                `👮 *МОДЕРАТОРЫ*\n\n━━━━━━━━━━━━━━━━━━━━\n\n📭 _Нет модераторов_`,
                {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '👥 Пользователи', callback_data: 'manage_users' }],
                            [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                        ]
                    }
                }
            ).catch(err => console.error('Ошибка:', err));
        } else {
            let message = `👮 *МОДЕРАТОРЫ*\n\n━━━━━━━━━━━━━━━━━━━━\n\n`;
            users.admins.forEach((adminId, index) => {
                message += `${index + 1}. ID: \`${adminId}\`\n\n`;
            });

            // Создаем кнопки для удаления модераторов
            const buttons = users.admins.map((adminId, index) => [
                { text: `🗑 Удалить #${index + 1}`, callback_data: `remove_moderator_${adminId}` }
            ]);

            buttons.push([{ text: '🔄 Обновить', callback_data: 'show_moderators' }]);
            buttons.push([{ text: '👥 Пользователи', callback_data: 'manage_users' }]);
            buttons.push([{ text: '🏠 Главное меню', callback_data: 'main_menu' }]);

            bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: buttons
                }
            }).catch(err => console.error('Ошибка:', err));
        }

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Удалить модератора
    if (data.startsWith('remove_moderator_')) {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        const targetAdminId = parseInt(data.replace('remove_moderator_', ''));

        if (!users.admins.includes(targetAdminId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Модератор не найден' });
            return;
        }

        // Удаляем из админов
        users.admins = users.admins.filter(id => id !== targetAdminId);
        saveUsers();

        // Уведомляем пользователя
        bot.sendMessage(targetAdminId,
            `❌ *Вы больше не модератор*\n\n` +
            `Ваши права администратора были отозваны.`,
            { parse_mode: 'Markdown' }
        ).catch(err => console.error('Ошибка уведомления пользователя:', err));

        bot.answerCallbackQuery(query.id, { text: '✅ Модератор удален' });

        // Обновляем список модераторов
        bot.answerCallbackQuery(query.id).then(() => {
            bot.emit('callback_query', { ...query, data: 'show_moderators' });
        });
        return;
    }

    // Показать заявки
    if (data === 'show_pending') {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        if (users.pending.length === 0) {
            bot.editMessageText(`📋 *ЗАЯВКИ НА ДОСТУП*\n\n━━━━━━━━━━━━━━━━━━━━\n\n📭 _Нет заявок на рассмотрении_`, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⚙️ Управление', callback_data: 'admin_panel' }],
                        [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                    ]
                }
            }).catch(err => console.error('Ошибка:', err));
        } else {
            let message = `📋 *ЗАЯВКИ НА ДОСТУП*\n\n━━━━━━━━━━━━━━━━━━━━\n\n`;
            users.pending.forEach((pendingUserId, index) => {
                message += `${index + 1}. ID: \`${pendingUserId}\`\n\n`;
            });

            // Создаем кнопки для каждой заявки
            const buttons = users.pending.map((pendingUserId, index) => [
                { text: `✅ Одобрить #${index + 1}`, callback_data: `approve_user_${pendingUserId}` },
                { text: `❌ Отклонить #${index + 1}`, callback_data: `reject_user_${pendingUserId}` }
            ]);

            buttons.push([{ text: '🔄 Обновить', callback_data: 'show_pending' }]);
            buttons.push([{ text: '⚙️ Управление', callback_data: 'admin_panel' }]);
            buttons.push([{ text: '🏠 Главное меню', callback_data: 'main_menu' }]);

            bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: buttons
                }
            }).catch(err => console.error('Ошибка:', err));
        }

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Показать забаненных
    if (data === 'show_banned') {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        if (users.banned.length === 0) {
            bot.editMessageText(`🚫 *ЗАБАНЕННЫЕ*\n\n━━━━━━━━━━━━━━━━━━━━\n\n📭 _Нет забаненных пользователей_`, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '👥 Пользователи', callback_data: 'manage_users' }],
                        [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                    ]
                }
            }).catch(err => console.error('Ошибка:', err));
        } else {
            let message = `🚫 *ЗАБАНЕННЫЕ*\n\n━━━━━━━━━━━━━━━━━━━━\n\n`;
            users.banned.forEach((bannedUserId, index) => {
                message += `${index + 1}. ID: \`${bannedUserId}\`\n`;
                message += `/unban ${bannedUserId}\n\n`;
            });

            bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Обновить', callback_data: 'show_banned' }],
                        [{ text: '👥 Пользователи', callback_data: 'manage_users' }],
                        [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                    ]
                }
            }).catch(err => console.error('Ошибка:', err));
        }

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Показать все заявки
    if (data === 'show_all_bookings') {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        const bookings = Object.entries(users.bookings || {});

        if (bookings.length === 0) {
            bot.editMessageText(`📦 *ВСЕ ЗАЯВКИ*\n\n━━━━━━━━━━━━━━━━━━━━\n\n📭 _Нет заявок_`, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⚙️ Управление', callback_data: 'admin_panel' }],
                        [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                    ]
                }
            }).catch(err => console.error('Ошибка:', err));
        } else {
            // Показываем последние 10 заявок
            const recentBookings = bookings.slice(-10).reverse();
            let message = `📦 *ВСЕ ЗАЯВКИ* (последние 10)\n\n━━━━━━━━━━━━━━━━━━━━\n\n`;

            recentBookings.forEach(([bookingId, booking], index) => {
                const statusEmoji = booking.status === 'completed' ? '✅' : booking.status === 'failed' ? '❌' : '⏳';
                const date = new Date(booking.timestamp);
                const dateStr = `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}`;

                message += `${statusEmoji} *${booking.cityName}* - ${booking.saunaName}\n`;
                message += `📅 ${dateStr} | 👤 ${booking.clientName}\n`;

                if (booking.status === 'completed' && booking.amount) {
                    message += `💰 ${booking.amount}₽ (доля: ${booking.workerShare}₽)\n`;
                }

                if (booking.takenBy && booking.takenBy.length > 0) {
                    message += `🤝 ${booking.takenBy[0].userName}\n`;
                }

                message += `\n`;
            });

            bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Обновить', callback_data: 'show_all_bookings' }],
                        [{ text: '⚙️ Управление', callback_data: 'admin_panel' }],
                        [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                    ]
                }
            }).catch(err => console.error('Ошибка:', err));
        }

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Показать топ воркеров
    if (data === 'show_top_workers') {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        // Собираем статистику по воркерам
        const workerStats = {};

        users.whitelist.forEach(workerId => {
            const stats = getWorkerStats(workerId);
            const workerInfo = Object.values(users.workerInfo || {}).find(w => w.userId === workerId);
            const workerName = workerInfo ? workerInfo.name : `ID: ${workerId}`;

            workerStats[workerId] = {
                name: workerName,
                completed: stats.completed || 0,
                failed: stats.failed || 0,
                total: stats.total || 0,
                earned: stats.totalEarned || 0
            };
        });

        // Сортируем по заработку
        const sortedWorkers = Object.entries(workerStats)
            .sort((a, b) => b[1].earned - a[1].earned)
            .slice(0, 10);

        if (sortedWorkers.length === 0) {
            bot.editMessageText(`🏆 *ТОП ВОРКЕРОВ*\n\n━━━━━━━━━━━━━━━━━━━━\n\n📭 _Нет данных_`, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⚙️ Управление', callback_data: 'admin_panel' }],
                        [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                    ]
                }
            }).catch(err => console.error('Ошибка:', err));
        } else {
            let message = `🏆 *ТОП ВОРКЕРОВ*\n\n━━━━━━━━━━━━━━━━━━━━\n\n`;

            sortedWorkers.forEach(([workerId, stats], index) => {
                const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
                message += `${medal} *${stats.name}*\n`;
                message += `💰 Заработано: ${stats.earned}₽\n`;
                message += `✅ Оплачено: ${stats.completed} | ❌ Не оплачено: ${stats.failed}\n`;
                message += `📊 Всего взято: ${stats.total}\n\n`;
            });

            bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Обновить', callback_data: 'show_top_workers' }],
                        [{ text: '⚙️ Управление', callback_data: 'admin_panel' }],
                        [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                    ]
                }
            }).catch(err => console.error('Ошибка:', err));
        }

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Одобрить пользователя
    if (data.startsWith('approve_user_')) {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        const targetUserId = parseInt(data.replace('approve_user_', ''));

        if (!users.pending.includes(targetUserId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Пользователь не найден в заявках' });
            return;
        }

        // Удаляем из pending и добавляем в whitelist
        users.pending = users.pending.filter(id => id !== targetUserId);
        if (!users.whitelist.includes(targetUserId)) {
            users.whitelist.push(targetUserId);
        }
        saveUsers();

        // Уведомляем пользователя
        bot.sendMessage(targetUserId,
            `✅ *Ваша заявка одобрена!*\n\n` +
            `Теперь вы можете пользоваться ботом.\n` +
            `Используйте /start для начала работы.`,
            { parse_mode: 'Markdown' }
        ).catch(err => console.error('Ошибка уведомления пользователя:', err));

        bot.answerCallbackQuery(query.id, { text: '✅ Пользователь одобрен' });

        // Обновляем список заявок
        bot.answerCallbackQuery(query.id).then(() => {
            // Trigger refresh of pending list
            bot.emit('callback_query', { ...query, data: 'show_pending' });
        });
        return;
    }

    // Отклонить пользователя
    if (data.startsWith('reject_user_')) {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        const targetUserId = parseInt(data.replace('reject_user_', ''));

        if (!users.pending.includes(targetUserId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Пользователь не найден в заявках' });
            return;
        }

        // Удаляем из pending
        users.pending = users.pending.filter(id => id !== targetUserId);
        saveUsers();

        // Уведомляем пользователя
        bot.sendMessage(targetUserId,
            `❌ *Ваша заявка отклонена*\n\n` +
            `К сожалению, вам отказано в доступе к боту.`,
            { parse_mode: 'Markdown' }
        ).catch(err => console.error('Ошибка уведомления пользователя:', err));

        bot.answerCallbackQuery(query.id, { text: '❌ Пользователь отклонен' });

        // Обновляем список заявок
        bot.answerCallbackQuery(query.id).then(() => {
            bot.emit('callback_query', { ...query, data: 'show_pending' });
        });
        return;
    }

    // Одобрить вывод
    if (data.startsWith('approve_withdrawal_')) {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        const withdrawalId = data.replace('approve_withdrawal_', '');
        const withdrawal = users.withdrawalRequests?.find(w => w.id === withdrawalId);

        if (!withdrawal) {
            bot.answerCallbackQuery(query.id, { text: '❌ Заявка не найдена' });
            return;
        }

        if (withdrawal.status !== 'pending') {
            bot.answerCallbackQuery(query.id, { text: '⚠️ Заявка уже обработана' });
            return;
        }

        // Обновляем статус заявки
        withdrawal.status = 'approved';
        withdrawal.approvedBy = userId;
        withdrawal.approvedAt = Date.now();

        // Вычитаем из доступного баланса
        if (!users.balances[withdrawal.userId]) {
            users.balances[withdrawal.userId] = { available: 0, totalEarned: 0 };
        }
        users.balances[withdrawal.userId].available -= withdrawal.amount;

        saveUsers();

        // Обновляем сообщение админа
        bot.editMessageText(
            `✅ *ЗАЯВКА ОДОБРЕНА*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `👤 *Воркер:* #${withdrawal.customTag}\n` +
            `👤 *Username:* ${withdrawal.userName}\n` +
            `💵 *Сумма:* ${withdrawal.amount.toLocaleString('ru-RU')}₽\n` +
            `✅ *Одобрил:* ${userName}\n` +
            `📅 *Дата:* ${new Date().toLocaleString('ru-RU')}`,
            {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown'
            }
        ).catch(err => console.error('Ошибка обновления сообщения:', err));

        // Уведомляем воркера
        bot.sendPhoto(withdrawal.userId, fs.createReadStream('./images/profuiit.jpg'), {
            caption: `✅ *ВЫПЛАТА ОДОБРЕНА!*\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `💰 *Сумма:* ${withdrawal.amount.toLocaleString('ru-RU')}₽\n` +
                `📅 *Дата:* ${new Date().toLocaleString('ru-RU')}\n\n` +
                `Средства будут переведены в ближайшее время.`,
            parse_mode: 'Markdown'
        }).catch(err => console.error('Ошибка уведомления воркера:', err));

        bot.answerCallbackQuery(query.id, { text: '✅ Выплата одобрена' });
        return;
    }

    // Отклонить вывод
    if (data.startsWith('reject_withdrawal_')) {
        if (!isAdmin(userId)) {
            bot.answerCallbackQuery(query.id, { text: '❌ Доступно только админам' });
            return;
        }

        const withdrawalId = data.replace('reject_withdrawal_', '');
        const withdrawal = users.withdrawalRequests?.find(w => w.id === withdrawalId);

        if (!withdrawal) {
            bot.answerCallbackQuery(query.id, { text: '❌ Заявка не найдена' });
            return;
        }

        if (withdrawal.status !== 'pending') {
            bot.answerCallbackQuery(query.id, { text: '⚠️ Заявка уже обработана' });
            return;
        }

        // Обновляем статус заявки
        withdrawal.status = 'rejected';
        withdrawal.rejectedBy = userId;
        withdrawal.rejectedAt = Date.now();

        saveUsers();

        // Обновляем сообщение админа
        bot.editMessageText(
            `❌ *ЗАЯВКА ОТКЛОНЕНА*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `👤 *Воркер:* #${withdrawal.customTag}\n` +
            `👤 *Username:* ${withdrawal.userName}\n` +
            `💵 *Сумма:* ${withdrawal.amount.toLocaleString('ru-RU')}₽\n` +
            `❌ *Отклонил:* ${userName}\n` +
            `📅 *Дата:* ${new Date().toLocaleString('ru-RU')}`,
            {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown'
            }
        ).catch(err => console.error('Ошибка обновления сообщения:', err));

        // Уведомляем воркера
        bot.sendPhoto(withdrawal.userId, fs.createReadStream('./images/grustno.jpg'), {
            caption: `❌ *ВЫПЛАТА ОТКЛОНЕНА*\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `💰 *Сумма:* ${withdrawal.amount.toLocaleString('ru-RU')}₽\n` +
                `📅 *Дата:* ${new Date().toLocaleString('ru-RU')}\n\n` +
                `Свяжитесь с администратором для уточнения причины.`,
            parse_mode: 'Markdown'
        }).catch(err => console.error('Ошибка уведомления воркера:', err));

        bot.answerCallbackQuery(query.id, { text: '❌ Выплата отклонена' });
        return;
    }

    // Использовать стандартные цены
    if (data === 'use_default_prices') {
        const tempData = users.tempLinkData?.[userId];
        if (!tempData) {
            bot.answerCallbackQuery(query.id, { text: '❌ Данные не найдены' });
            return;
        }

        // Переходим к выбору адреса
        users.userStates[userId] = 'waiting_for_address_choice';
        saveUsers();

        const cityData = tempData.cityData;
        bot.editMessageText(
            `✅ *Цены установлены (стандартные)*\n\n` +
            `📍 *Адрес по умолчанию:*\n${cityData.address}\n\n` +
            `Хотите использовать этот адрес или указать свой?`,
            {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✅ Использовать стандартный', callback_data: 'use_default_address' }],
                        [{ text: '✏️ Указать свой адрес', callback_data: 'use_custom_address' }]
                    ]
                }
            }
        );

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Указать свои цены
    if (data === 'use_custom_prices') {
        const tempData = users.tempLinkData?.[userId];
        if (!tempData) {
            bot.answerCallbackQuery(query.id, { text: '❌ Данные не найдены' });
            return;
        }

        users.userStates[userId] = 'waiting_for_custom_prices';
        saveUsers();

        bot.editMessageText(
            `✏️ *Укажите свои цены*\n\n` +
            `Введите цены через запятую в формате:\n` +
            `\`Байкал, Тайга, Баня\`\n\n` +
            `*Пример:* 5000, 4500, 4000`,
            {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown'
            }
        );

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Использовать стандартный адрес
    if (data === 'use_default_address') {
        const tempData = users.tempLinkData?.[userId];
        if (!tempData) {
            bot.answerCallbackQuery(query.id, { text: '❌ Данные не найдены' });
            return;
        }

        // Создаем ссылку (используем кастомные цены если были указаны)
        const customPrices = tempData.customPrices || null;
        createLinkForUser(userId, tempData, customPrices, null, chatId, messageId);
        bot.answerCallbackQuery(query.id);
        return;
    }

    // Указать свой адрес
    if (data === 'use_custom_address') {
        const tempData = users.tempLinkData?.[userId];
        if (!tempData) {
            bot.answerCallbackQuery(query.id, { text: '❌ Данные не найдены' });
            return;
        }

        users.userStates[userId] = 'waiting_for_custom_address';
        saveUsers();

        bot.editMessageText(
            `✏️ *Укажите свой адрес*\n\n` +
            `Введите адрес в формате:\n` +
            `\`г. Город, ул. Улица, дом\`\n\n` +
            `*Пример:* г. Москва, ул. Ленина, 10`,
            {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown'
            }
        );

        bot.answerCallbackQuery(query.id);
        return;
    }

    // Кнопка "Взял на отработку"
    if (data.startsWith('take_')) {
        const bookingId = data.replace('take_', '');
        const booking = users.bookings?.[bookingId];

        if (!booking) {
            bot.answerCallbackQuery(query.id, { text: '❌ Заявка не найдена' });
            return;
        }

        // Проверяем, не взял ли уже этот работник заявку
        if (booking.takenBy.some(w => w.userId === userId)) {
            bot.answerCallbackQuery(query.id, { text: '⚠️ Вы уже взяли эту заявку' });
            return;
        }

        // Добавляем работника в список взявших
        booking.takenBy.push({
            userId,
            userName,
            timestamp: Date.now()
        });

        // Увеличиваем счетчик заявок работника
        const stats = getWorkerStats(userId);
        stats.total++;
        saveUsers();

        // Обновляем сообщение - убираем кнопку "Взял"
        const originalText = query.message.text;
        const updatedText = `${originalText}\n\n🤝 Взято на отработку`;

        bot.editMessageText(updatedText, {
            chat_id: chatId,
            message_id: messageId
        }).catch(err => {
            console.error('Ошибка обновления сообщения:', err);
        });

        bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
            chat_id: chatId,
            message_id: messageId
        }).catch(err => {
            // Это не критично: Telegram ругается, если разметка не изменилась.
            if (err?.response?.body?.description?.includes('message is not modified')) return;
            console.error('Ошибка удаления кнопок:', err);
        });

        // Отправляем новое сообщение с кнопками отработки
        const workMessage = `📋 *Ваша заявка на отработку*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `🏙 *Город:* ${booking.cityName}\n` +
            `👤 *Клиент:* ${booking.clientName}\n` +
            `🏔 *Сауна:* ${booking.saunaName}\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
            `⏳ _Отметьте результат после работы с клиентом_`;

        bot.sendMessage(chatId, workMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Оплатил', callback_data: `done_${bookingId}` },
                    { text: '❌ Не оплатил', callback_data: `failed_${bookingId}` }
                ]]
            }
        }).catch(err => {
            console.error('Ошибка отправки сообщения с кнопками:', err);
        });

        bot.answerCallbackQuery(query.id, { text: '✅ Заявка взята на отработку' });

        // Уведомляем создателя ссылки (воркера), что заявку взяли в работу
        const creatorId = booking.creatorId || users.linkCreators?.[booking.cityKey] || users.workerInfo?.[booking.cityKey]?.userId;
        if (creatorId && creatorId !== userId) {
            // Без Markdown — чтобы не было лишних "звёздочек" и ошибок парсинга
            bot.sendMessage(creatorId,
                `🤝 Вашу заявку взяли в работу!\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `👤 Работник: ${userName}\n` +
                `🏙 Город: ${booking.cityName}\n` +
                `👥 Клиент: ${booking.clientName}\n` +
                `🏔 Сауна: ${booking.saunaName}`
            ).catch(err => {
                console.error('Ошибка уведомления создателя ссылки:', err);
            });
        }
    }

    // Кнопки "Оплатил" / "Не оплатил"
    if (data.startsWith('done_') || data.startsWith('failed_')) {
        const bookingId = data.replace('done_', '').replace('failed_', '');
        const booking = users.bookings?.[bookingId];

        if (!booking) {
            bot.answerCallbackQuery(query.id, { text: '❌ Заявка не найдена' });
            return;
        }

        // Проверяем, брал ли этот работник заявку
        const workerTook = booking.takenBy.some(w => w.userId === userId);
        if (!workerTook) {
            bot.answerCallbackQuery(query.id, { text: '❌ Вы не брали эту заявку' });
            return;
        }

        // Проверяем, не закрыта ли уже заявка этим работником
        if (booking.completedBy && booking.completedBy.userId === userId) {
            bot.answerCallbackQuery(query.id, { text: '⚠️ Вы уже отметили эту заявку' });
            return;
        }

        const isPaid = data.startsWith('done_');

        if (isPaid) {
            // Если оплачено - запрашиваем сумму
            if (!users.userStates) users.userStates = {};
            users.userStates[userId] = {
                state: 'waiting_for_amount',
                bookingId: bookingId
            };
            saveUsers();

            // Обновляем сообщение
            const originalText = query.message.text;
            const updatedText = `${originalText}\n\n💰 Введите сумму оплаты (в рублях):`;

            bot.editMessageText(updatedText, {
                chat_id: chatId,
                message_id: messageId
            }).catch(err => {
                console.error('Ошибка обновления сообщения:', err);
            });

            bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                chat_id: chatId,
                message_id: messageId
            }).catch(err => {
                // Это не критично: Telegram ругается, если разметка не изменилась.
                if (err?.response?.body?.description?.includes('message is not modified')) return;
                console.error('Ошибка удаления кнопок:', err);
            });

            bot.answerCallbackQuery(query.id, { text: '💰 Введите сумму оплаты' });
        } else {
            // Если не оплачено - сразу закрываем
            const status = '❌ Не оплатил';

            // Обновляем статистику работника
            const stats = getWorkerStats(userId);
            stats.failed++;

            // Обновляем статус заявки
            booking.status = 'failed';
            booking.completedBy = {
                userId,
                userName,
                timestamp: Date.now()
            };
            saveUsers();

            // Обновляем сообщение
            const originalText = query.message.text;
            const updatedText = `${originalText}\n\n${status}`;

            bot.editMessageText(updatedText, {
                chat_id: chatId,
                message_id: messageId
            }).catch(err => {
                console.error('Ошибка обновления сообщения:', err);
            });

            bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                chat_id: chatId,
                message_id: messageId
            }).catch(err => {
                // Это не критично: Telegram ругается, если разметка не изменилась.
                if (err?.response?.body?.description?.includes('message is not modified')) return;
                console.error('Ошибка удаления кнопок:', err);
            });

            bot.answerCallbackQuery(query.id, { text: '❌ Отмечено как не оплачено' });

            // Уведомляем создателя ссылки о результате с фото
            const creatorId = booking.creatorId || users.linkCreators?.[booking.cityKey] || users.workerInfo?.[booking.cityKey]?.userId;
            if (creatorId) {
                const statusMessage = `❌ *Заявка не оплачена*\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `🏙 *Город:* ${booking.cityName}\n` +
                    `👤 *Работник:* ${userName}\n` +
                    `👥 *Клиент:* ${booking.clientName}`;

                bot.sendPhoto(creatorId, fs.createReadStream('./images/grustno.jpg'), {
                    caption: statusMessage,
                    parse_mode: 'Markdown'
                }).catch(err => {
                    console.error('Ошибка отправки фото грустного результата:', err);
                });
            }
        }

        // Уведомляем админов о результате
        users.admins.forEach(adminId => {
            const adminMessage = isPaid
                ? `✅ *Заявка оплачена!*\n\n` +
                  `━━━━━━━━━━━━━━━━━━━━\n` +
                  `👤 *Работник:* ${userName}\n` +
                  `🏙 *Город:* ${booking.cityName}\n` +
                  `👥 *Клиент:* ${booking.clientName}\n` +
                  `💬 *Telegram:* ${booking.clientTelegram}`
                : `❌ *Заявка не оплачена*\n\n` +
                  `━━━━━━━━━━━━━━━━━━━━\n` +
                  `👤 *Работник:* ${userName}\n` +
                  `🏙 *Город:* ${booking.cityName}\n` +
                  `👥 *Клиент:* ${booking.clientName}\n` +
                  `💬 *Telegram:* ${booking.clientTelegram}`;

            bot.sendMessage(adminId, adminMessage, { parse_mode: 'Markdown' }).catch(err => {
                console.error('Ошибка уведомления админа:', err);
            });
        });
    }
});

// Команда /prices - посмотреть цены города
bot.onText(/\/prices (.+)/, (msg, match) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const cityInput = match[1].trim();

    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Эта команда доступна только администраторам.');
        return;
    }

    const cityKey = transliterate(cityInput.toLowerCase().replace(/\s+/g, '-'));

    if (!cities[cityKey]) {
        bot.sendMessage(chatId, `❌ Город "${cityInput}" не найден в базе.\n\nДоступные города: ${Object.keys(cities).join(', ')}`);
        return;
    }

    const city = cities[cityKey];
    const message = `💰 Цены для города ${city.name}:\n\n` +
        `🏔 Байкал: ${city.prices.baikal}₽/час\n` +
        `🌲 Тайга: ${city.prices.taiga}₽/час\n` +
        `🔥 Русская баня: ${city.prices.banya}₽/час`;

    bot.sendMessage(chatId, message);
});

// Команда /setprice - изменить цену
bot.onText(/\/setprice (.+) (baikal|taiga|banya) (\d+)/, (msg, match) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const cityInput = match[1].trim();
    const saunaType = match[2];
    const newPrice = parseInt(match[3]);

    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ Эта команда доступна только администраторам.');
        return;
    }

    const cityKey = transliterate(cityInput.toLowerCase().replace(/\s+/g, '-'));

    if (!cities[cityKey]) {
        bot.sendMessage(chatId, `❌ Город "${cityInput}" не найден в базе.\n\nДоступные города: ${Object.keys(cities).join(', ')}`);
        return;
    }

    const oldPrice = cities[cityKey].prices[saunaType];
    cities[cityKey].prices[saunaType] = newPrice;

    // Сохраняем изменения в файл
    fs.writeFileSync('./cities.json', JSON.stringify(cities, null, 2));

    const saunaNames = {
        'baikal': 'Байкал',
        'taiga': 'Тайга',
        'banya': 'Русская баня'
    };

    bot.sendMessage(
        chatId,
        `✅ Цена обновлена!\n\n` +
        `🏙 Город: ${cities[cityKey].name}\n` +
        `🏔 Сауна: ${saunaNames[saunaType]}\n` +
        `💰 Старая цена: ${oldPrice}₽/час\n` +
        `💰 Новая цена: ${newPrice}₽/час`
    );
});
// Обработка ввода города
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    // Пропускаем команды
    if (text.startsWith('/')) return;

    // Проверяем состояние пользователя
    if (!users.userStates) users.userStates = {};

    // Обработка заявки на доступ - ПЕРЕД проверкой доступа
    if (users.userStates[userId] === 'waiting_for_application_source') {
        if (!users.applications) users.applications = {};
        users.applications[userId] = { source: text.trim() };
        users.userStates[userId] = 'waiting_for_application_experience';
        saveUsers();

        bot.sendMessage(chatId,
            `2️⃣ *Расскажите о вашем опыте работы*\n\n` +
            `_Опишите ваш опыт (можно кратко):_`,
            { parse_mode: 'Markdown' }
        );
        return;
    }

    if (users.userStates[userId] === 'waiting_for_application_experience') {
        users.applications[userId].experience = text.trim();
        users.userStates[userId] = 'waiting_for_application_about';
        saveUsers();

        bot.sendMessage(chatId,
            `3️⃣ *Расскажите о себе*\n\n` +
            `_Немного информации о вас:_`,
            { parse_mode: 'Markdown' }
        );
        return;
    }

    if (users.userStates[userId] === 'waiting_for_application_about') {
        users.applications[userId].about = text.trim();
        users.applications[userId].timestamp = Date.now();

        // Добавляем в список ожидания
        users.pending.push(userId);
        delete users.userStates[userId];
        saveUsers();

        bot.sendMessage(chatId,
            `✅ *Заявка отправлена!*\n\n` +
            `Спасибо за заполнение анкеты.\n` +
            `Администратор рассмотрит вашу заявку в ближайшее время.`,
            { parse_mode: 'Markdown' }
        );

        // Уведомляем всех админов
        const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
        const app = users.applications[userId];
        users.admins.forEach(adminId => {
            bot.sendMessage(
                adminId,
                `🔔 *Новая заявка на доступ*\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `👤 *Пользователь:* ${username}\n` +
                `🆔 *ID:* \`${userId}\`\n\n` +
                `📍 *Откуда узнал:* ${app.source}\n` +
                `💼 *Опыт:* ${app.experience}\n` +
                `👨‍💼 *О себе:* ${app.about}\n\n` +
                `_Используйте кнопки в разделе "📋 Заявки на доступ"_`,
                { parse_mode: 'Markdown' }
            );
        });
        return;
    }

    // Проверка доступа - ПОСЛЕ обработки заявки
    if (!hasAccess(userId)) {
        bot.sendMessage(chatId, '❌ У вас нет доступа к боту. Используйте /start для подачи заявки.');
        return;
    }

    // Обработка ввода суммы оплаты
    if (users.userStates[userId] && typeof users.userStates[userId] === 'object' && users.userStates[userId].state === 'waiting_for_amount') {
        const amount = parseFloat(text);

        if (isNaN(amount) || amount <= 0) {
            bot.sendMessage(chatId, '❌ Неверная сумма. Введите число больше 0.');
            return;
        }

        const bookingId = users.userStates[userId].bookingId;
        const booking = users.bookings?.[bookingId];

        if (!booking) {
            bot.sendMessage(chatId, '❌ Заявка не найдена.');
            delete users.userStates[userId];
            saveUsers();
            return;
        }

        // Рассчитываем долю воркера (70%)
        const workerShare = Math.round(amount * 0.7);

        // Находим создателя ссылки (воркера)
        // Приоритет: creatorId, сохраненный в заявке → linkCreators → закрепленный воркер по городу
        const creatorId = booking.creatorId || users.linkCreators?.[booking.cityKey] || users.workerInfo?.[booking.cityKey]?.userId;

        // Обновляем статистику создателя ссылки (воркера)
        if (creatorId) {
            const stats = getWorkerStats(creatorId);
            stats.completed++;
            if (!stats.totalEarned) stats.totalEarned = 0;
            stats.totalEarned += workerShare;

            // Обновляем баланс воркера
            if (!users.balances) users.balances = {};
            if (!users.balances[creatorId]) {
                users.balances[creatorId] = { available: 0, totalEarned: 0 };
            }
            users.balances[creatorId].available += workerShare;
            users.balances[creatorId].totalEarned += workerShare;
        }

        // Обновляем статус заявки
        booking.status = 'completed';
        booking.amount = amount;
        booking.workerShare = workerShare;
        booking.completedBy = {
            userId,
            userName: msg.from.username ? `@${msg.from.username}` : msg.from.first_name,
            timestamp: Date.now()
        };

        // Сбрасываем состояние
        delete users.userStates[userId];
        saveUsers();

        // Подтверждение админу, который ввел сумму
        bot.sendMessage(chatId, `✅ Заявка обработана. Сумма: ${amount}₽, доля воркера: ${workerShare}₽`);

        // Отправляем уведомление с фото создателю ссылки (воркеру)
        if (creatorId) {
            bot.sendPhoto(creatorId, fs.createReadStream('./images/profuiit.jpg'), {
                caption: `✅ *Заявка успешно оплачена!*\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `💵 *Сумма профита:* ${amount}₽\n` +
                    `📈 *Ваша доля (70%):* ${workerShare}₽`,
                parse_mode: 'Markdown'
            }).catch(err => {
                console.error('Ошибка отправки фото профита:', err);
            });
        }

        return;
    }

    // Поиск пользователя (админ)
    if (users.userStates[userId] === 'waiting_for_user_search') {
        const q = text.trim();
        let targetUserId = null;

        if (/^\d+$/.test(q)) {
            targetUserId = parseInt(q);
        } else {
            const cleaned = q.replace(/^@/, '').replace(/^#/, '').toLowerCase();

            // 1) Поиск по сохраненному username
            for (const [uid, uname] of Object.entries(users.usernames || {})) {
                if ((uname || '').toLowerCase() === cleaned) {
                    targetUserId = parseInt(uid);
                    break;
                }
            }

            // 2) Поиск по тэгу
            if (!targetUserId) {
                for (const [uid, tag] of Object.entries(users.customTags || {})) {
                    if ((tag || '').toLowerCase() === cleaned) {
                        targetUserId = parseInt(uid);
                        break;
                    }
                }
            }

            if (!targetUserId) {
                bot.sendMessage(chatId, '❌ Пользователь не найден. Используйте ID / @username / #tag.');
                return;
            }
        }

        // Создаем базовые структуры, если их нет
        if (!users.admins) users.admins = [];
        if (!users.whitelist) users.whitelist = [];
        if (!users.banned) users.banned = [];
        if (!users.customTags) users.customTags = {};
        if (!users.balances) users.balances = {};
        if (!users.registrationDates) users.registrationDates = {};

        if (!users.balances[targetUserId]) users.balances[targetUserId] = { available: 0, totalEarned: 0 };

        const isUserAdmin = users.admins.includes(targetUserId);
        const isUserWorker = users.whitelist.includes(targetUserId);
        const isUserBanned = users.banned.includes(targetUserId);
        const tag = users.customTags[targetUserId] || 'не задан';
        const uname = users.usernames?.[targetUserId] ? `@${users.usernames[targetUserId]}` : 'нет';
        const reg = users.registrationDates[targetUserId];
        const bal = users.balances[targetUserId];

        const message =
            `👤 *ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
            `🆔 *ID:* \`${targetUserId}\`\n` +
            `👤 *Username:* ${uname}\n` +
            `🏷 *Тэг:* #${tag}\n` +
            (reg ? `📅 *Регистрация:* ${new Date(reg).toLocaleString('ru-RU')}\n` : '') +
            `\n👮 *Роли:* ${isUserAdmin ? 'Админ' : isUserWorker ? 'Воркер' : 'Нет доступа'}\n` +
            `🚫 *Бан:* ${isUserBanned ? 'Да' : 'Нет'}\n` +
            `\n💰 *Баланс:*\n` +
            `• Доступно: ${Number(bal.available || 0).toLocaleString('ru-RU')} ₽\n` +
            `• Всего: ${Number(bal.totalEarned || 0).toLocaleString('ru-RU')} ₽`;

        users.userStates[userId] = { state: 'editing_user', targetUserId };
        saveUsers();

        const buttons = [
            [
                { text: isUserWorker ? '➖ Убрать доступ' : '➕ Дать доступ', callback_data: `toggle_access_${targetUserId}` },
                { text: isUserBanned ? '✅ Разбан' : '🚫 Бан', callback_data: `toggle_ban_${targetUserId}` }
            ],
            [
                { text: '🏷 Изменить тэг', callback_data: `admin_change_tag_${targetUserId}` },
                { text: '💰 Изменить баланс', callback_data: `admin_set_balance_${targetUserId}` }
            ],
            [
                { text: '🔎 Новый поиск', callback_data: 'search_user' },
                { text: '👥 Назад', callback_data: 'manage_users' }
            ]
        ];

        bot.sendMessage(chatId, message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
        return;
    }

    // Обработка поиска воркера
    if (users.userStates[userId] === 'waiting_for_worker_search') {
        const isUserAdmin = users.admins?.includes(targetUserId);
        const isUserWorker = users.whitelist?.includes(targetUserId);
        const isUserBanned = users.banned?.includes(targetUserId);
        const tag = users.customTags?.[targetUserId] || 'не задан';
        const reg = users.registrationDates?.[targetUserId];
        const bal = users.balances?.[targetUserId] || { available: 0, totalEarned: 0 };

        const message =
            `👤 *ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
            `🆔 *ID:* \`${targetUserId}\`\n` +
            `🏷 *Тэг:* #${tag}\n` +
            (reg ? `📅 *Регистрация:* ${new Date(reg).toLocaleString('ru-RU')}\n` : '') +
            `\n👮 *Роли:* ${isUserAdmin ? 'Админ' : isUserWorker ? 'Воркер' : 'Нет доступа'}\n` +
            `🚫 *Бан:* ${isUserBanned ? 'Да' : 'Нет'}\n` +
            `\n💰 *Баланс:*\n` +
            `• Доступно: ${Number(bal.available || 0).toLocaleString('ru-RU')} ₽\n` +
            `• Всего: ${Number(bal.totalEarned || 0).toLocaleString('ru-RU')} ₽`;

        users.userStates[userId] = { state: 'editing_user', targetUserId };
        saveUsers();

        const buttons = [
            [
                { text: isUserWorker ? '➖ Убрать доступ' : '➕ Дать доступ', callback_data: `toggle_access_${targetUserId}` },
                { text: isUserBanned ? '✅ Разбан' : '🚫 Бан', callback_data: `toggle_ban_${targetUserId}` }
            ],
            [
                { text: '🏷 Изменить тэг', callback_data: `admin_change_tag_${targetUserId}` },
                { text: '💰 Изменить баланс', callback_data: `admin_set_balance_${targetUserId}` }
            ],
            [
                { text: '🔎 Новый поиск', callback_data: 'search_user' },
                { text: '👥 Назад', callback_data: 'manage_users' }
            ]
        ];

        bot.sendMessage(chatId, message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
        return;
    }

    // Обработка поиска воркера
    if (users.userStates[userId] === 'waiting_for_worker_search') {
        const searchQuery = text.trim();
        let targetUserId = null;

        // Проверяем, это ID или тег
        if (/^\d+$/.test(searchQuery)) {
            // Это ID
            targetUserId = parseInt(searchQuery);
        } else {
            // Это тег, ищем по customTags
            for (const [uid, tag] of Object.entries(users.customTags || {})) {
                if (tag.toLowerCase() === searchQuery.toLowerCase() || `#${tag}`.toLowerCase() === searchQuery.toLowerCase()) {
                    targetUserId = parseInt(uid);
                    break;
                }
            }
        }

        if (!targetUserId || !hasAccess(targetUserId)) {
            bot.sendMessage(chatId, '❌ Воркер не найден в базе.');
            return;
        }

        // Получаем данные воркера
        const stats = getWorkerStats(targetUserId);
        const workerTag = users.customTags?.[targetUserId] || targetUserId;
        const balance = users.balances?.[targetUserId] || { available: 0, totalEarned: 0 };
        const regDate = users.registrationDates?.[targetUserId] ? new Date(users.registrationDates[targetUserId]) : null;

        // Получаем зарезервированные города
        const workerCities = [];
        const now = Date.now();
        const expiryTime = 24 * 60 * 60 * 1000;

        if (users.cityReservations) {
            for (const [cityKey, reservation] of Object.entries(users.cityReservations)) {
                if (reservation.userId === targetUserId) {
                    const timeLeft = expiryTime - (now - reservation.timestamp);
                    if (timeLeft > 0) {
                        const hoursLeft = Math.floor(timeLeft / (60 * 60 * 1000));
                        const cityVisits = users.cityVisits?.[cityKey] || 0;
                        const cityBookings = Object.values(users.bookings || {}).filter(b => b.cityKey === cityKey).length;

                        workerCities.push({
                            cityName: reservation.cityName,
                            cityKey,
                            hoursLeft,
                            visits: cityVisits,
                            bookings: cityBookings
                        });
                    }
                }
            }
        }

        // Получаем последнюю активность
        let lastActivity = 'Нет данных';
        const userBookings = Object.values(users.bookings || {}).filter(b => {
            const creatorId = users.linkCreators?.[b.cityKey];
            return creatorId === targetUserId;
        });

        if (userBookings.length > 0) {
            const lastBooking = userBookings[userBookings.length - 1];
            const lastDate = new Date(lastBooking.timestamp);
            lastActivity = `${String(lastDate.getDate()).padStart(2, '0')}.${String(lastDate.getMonth() + 1).padStart(2, '0')}.${lastDate.getFullYear()} ${String(lastDate.getHours()).padStart(2, '0')}:${String(lastDate.getMinutes()).padStart(2, '0')}`;
        }

        let message = `👤 *ПРОФИЛЬ ВОРКЕРА*\n\n━━━━━━━━━━━━━━━━━━━━\n\n`;
        message += `📇 *ID:* \`${targetUserId}\`\n`;
        message += `📇 *Тэг:* #${workerTag}\n`;
        if (regDate) {
            message += `📅 *Регистрация:* ${String(regDate.getDate()).padStart(2, '0')}.${String(regDate.getMonth() + 1).padStart(2, '0')}.${regDate.getFullYear()}\n`;
        }
        message += `\n💰 *ФИНАНСЫ:*\n`;
        message += `• Доступно: ${balance.available.toLocaleString('ru-RU')}₽\n`;
        message += `• Всего заработано: ${balance.totalEarned.toLocaleString('ru-RU')}₽\n`;
        message += `\n📊 *СТАТИСТИКА:*\n`;
        message += `• Профитов: ${stats.completed || 0}\n`;
        message += `• Средний чек: ${stats.completed > 0 ? Math.round(stats.totalEarned / stats.completed) : 0}₽\n`;
        message += `• Последняя активность: ${lastActivity}\n`;

        if (workerCities.length > 0) {
            message += `\n🏙 *ГОРОДА (${workerCities.length}/3):*\n`;
            workerCities.forEach(city => {
                message += `• ${city.cityName} (~${city.hoursLeft}ч)\n`;
                message += `  👁 ${city.visits} | 📋 ${city.bookings}\n`;
            });
        } else {
            message += `\n🏙 *ГОРОДА:* Нет резерваций\n`;
        }

        const buttons = [
            [{ text: '🔍 Новый поиск', callback_data: 'search_worker' }],
            [{ text: '⚙️ Управление', callback_data: 'admin_panel' }]
        ];

        delete users.userStates[userId];
        saveUsers();

        bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });

        return;
    }

    // Обработка ввода ID модератора
    if (users.userStates[userId] === 'waiting_for_moderator_id') {
        const moderatorId = parseInt(text.trim());

        if (isNaN(moderatorId)) {
            bot.sendMessage(chatId, '❌ Неверный ID. Введите числовой Telegram ID.');
            return;
        }

        // Проверяем, не является ли уже админом
        if (users.admins.includes(moderatorId)) {
            bot.sendMessage(chatId, '⚠️ Этот пользователь уже является модератором.');
            delete users.userStates[userId];
            saveUsers();
            return;
        }

        // Добавляем в админы
        users.admins.push(moderatorId);
        delete users.userStates[userId];
        saveUsers();

        // Уведомляем нового модератора
        bot.sendMessage(moderatorId,
            `🎉 *Вы назначены модератором!*\n\n` +
            `Теперь у вас есть доступ к админ-панели.\n` +
            `Используйте /admin для открытия панели управления.`,
            { parse_mode: 'Markdown' }
        ).catch(err => console.error('Ошибка уведомления модератора:', err));

        bot.sendMessage(chatId,
            `✅ *Модератор добавлен!*\n\n` +
            `ID: \`${moderatorId}\`\n\n` +
            `Пользователь получил уведомление о назначении.`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '👮 Список модераторов', callback_data: 'show_moderators' }],
                        [{ text: '👥 Пользователи', callback_data: 'manage_users' }],
                        [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                    ]
                }
            }
        );

        return;
    }

    // Админ вводит новый тэг для пользователя
    if (users.userStates[userId] && typeof users.userStates[userId] === 'object' && users.userStates[userId].state === 'waiting_for_admin_new_tag') {
        const targetUserId = users.userStates[userId].targetUserId;
        const newTag = text.trim().toLowerCase().replace(/^#/, '');

        if (!/^[a-z0-9-]+$/.test(newTag) || newTag.length < 3 || newTag.length > 20) {
            bot.sendMessage(chatId, '❌ Неверный тэг. Разрешено: латиница/цифры/дефис. Длина 3-20.');
            return;
        }

        if (!users.customTags) users.customTags = {};
        const tagExists = Object.entries(users.customTags).some(([uid, tag]) => parseInt(uid) !== targetUserId && tag === newTag);
        if (tagExists) {
            bot.sendMessage(chatId, '❌ Этот тэг уже занят.');
            return;
        }

        users.customTags[targetUserId] = newTag;
        delete users.userStates[userId];
        saveUsers();

        bot.sendMessage(chatId, `✅ Тэг обновлён для ID ${targetUserId}: #${newTag}`);
        return;
    }

    // Админ вводит новый баланс для пользователя
    if (users.userStates[userId] && typeof users.userStates[userId] === 'object' && users.userStates[userId].state === 'waiting_for_admin_new_balance') {
        const targetUserId = users.userStates[userId].targetUserId;
        const amount = parseFloat(String(text).replace(',', '.'));

        if (isNaN(amount) || amount < 0) {
            bot.sendMessage(chatId, '❌ Неверная сумма. Введите число 0 или больше.');
            return;
        }

        if (!users.balances) users.balances = {};
        if (!users.balances[targetUserId]) users.balances[targetUserId] = { available: 0, totalEarned: 0 };
        users.balances[targetUserId].available = amount;

        delete users.userStates[userId];
        saveUsers();

        bot.sendMessage(chatId, `✅ Баланс “К выплате” обновлён для ID ${targetUserId}: ${amount.toLocaleString('ru-RU')} ₽`);
        return;
    }

    // Обработка ввода нового тэга
    if (users.userStates[userId] === 'waiting_for_new_tag') {
        const newTag = text.trim().toLowerCase();

        // Валидация тэга
        if (!/^[a-z0-9-]+$/.test(newTag)) {
            bot.sendMessage(chatId, '❌ Тэг может содержать только латинские буквы, цифры и дефис.');
            return;
        }

        if (newTag.length < 3 || newTag.length > 20) {
            bot.sendMessage(chatId, '❌ Длина тэга должна быть от 3 до 20 символов.');
            return;
        }

        // Проверяем уникальность
        const tagExists = Object.values(users.customTags || {}).some(tag => tag === newTag);
        if (tagExists) {
            bot.sendMessage(chatId, '❌ Этот тэг уже занят. Выберите другой.');
            return;
        }

        // Обновляем тэг
        if (!users.customTags) users.customTags = {};
        users.customTags[userId] = newTag;
        delete users.userStates[userId];
        saveUsers();

        bot.sendMessage(chatId,
            `✅ *Тэг успешно изменен!*\n\n` +
            `Ваш новый тэг: #${newTag}`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📊 Мой профиль', callback_data: 'show_profile' }],
                        [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                    ]
                }
            }
        );

        return;
    }

    // Обработка ввода суммы вывода
    if (users.userStates[userId] === 'waiting_for_withdrawal_amount') {
        const amount = parseFloat(text);
        const stats = getWorkerStats(userId);
        const balance = users.balances?.[userId];
        const availableBalance = balance?.available || stats.totalEarned || 0;

        if (isNaN(amount) || amount <= 0) {
            bot.sendMessage(chatId, '❌ Неверная сумма. Введите число больше 0.');
            return;
        }

        if (amount < 500) {
            bot.sendMessage(chatId, '❌ Минимальная сумма для вывода: 500₽');
            return;
        }

        if (amount > availableBalance) {
            bot.sendMessage(chatId, `❌ Недостаточно средств. Доступно: ${availableBalance.toLocaleString('ru-RU')}₽`);
            return;
        }

        // Создаем заявку на вывод
        if (!users.withdrawalRequests) users.withdrawalRequests = [];

        const withdrawalId = `withdrawal_${userId}_${Date.now()}`;
        users.withdrawalRequests.push({
            id: withdrawalId,
            userId,
            userName: msg.from.username ? `@${msg.from.username}` : msg.from.first_name,
            customTag: users.customTags?.[userId] || 'unknown',
            amount,
            status: 'pending',
            timestamp: Date.now()
        });

        delete users.userStates[userId];
        saveUsers();

        bot.sendMessage(chatId,
            `✅ *Заявка на вывод создана!*\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `💰 *Сумма:* ${amount.toLocaleString('ru-RU')}₽\n` +
            `⏳ *Статус:* Ожидает обработки\n\n` +
            `Администратор обработает вашу заявку в ближайшее время.`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🏠 Главное меню', callback_data: 'main_menu' }]
                    ]
                }
            }
        );

        // Уведомляем админов
        users.admins.forEach(adminId => {
            const realUsername = query.from.username ? `@${query.from.username}` : 'Нет username';
            bot.sendMessage(adminId,
                `💰 *НОВАЯ ЗАЯВКА НА ВЫВОД*\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `👤 *Воркер:* #${users.customTags?.[userId] || userId}\n` +
                `👤 *Username:* ${realUsername}\n` +
                `💵 *Сумма:* ${amount.toLocaleString('ru-RU')}₽\n` +
                `📇 *ID:* ${userId}`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '✅ Одобрить', callback_data: `approve_withdrawal_${withdrawalId}` },
                                { text: '❌ Отклонить', callback_data: `reject_withdrawal_${withdrawalId}` }
                            ]
                        ]
                    }
                }
            ).catch(err => console.error('Ошибка уведомления админа:', err));
        });

        return;
    }

    // Обработка кастомных цен
    if (users.userStates[userId] === 'waiting_for_custom_prices') {
        const tempData = users.tempLinkData?.[userId];
        if (!tempData) {
            bot.sendMessage(chatId, '❌ Данные не найдены. Начните создание ссылки заново.');
            delete users.userStates[userId];
            saveUsers();
            return;
        }

        // Парсим цены
        const pricesArray = text.trim().split(',').map(p => parseInt(p.trim()));

        if (pricesArray.length !== 3 || pricesArray.some(p => isNaN(p) || p <= 0)) {
            bot.sendMessage(chatId,
                `❌ *Неверный формат!*\n\n` +
                `Введите три числа через запятую.\n` +
                `*Пример:* 5000, 4500, 4000`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const customPrices = {
            baikal: pricesArray[0],
            taiga: pricesArray[1],
            banya: pricesArray[2]
        };

        // Сохраняем кастомные цены во временные данные
        tempData.customPrices = customPrices;

        // Переходим к выбору адреса
        users.userStates[userId] = 'waiting_for_address_choice';
        saveUsers();

        const cityData = tempData.cityData;
        bot.sendMessage(chatId,
            `✅ *Цены установлены*\n\n` +
            `• Байкал: ${customPrices.baikal}₽/час\n` +
            `• Тайга: ${customPrices.taiga}₽/час\n` +
            `• Русская баня: ${customPrices.banya}₽/час\n\n` +
            `📍 *Адрес по умолчанию:*\n${cityData.address}\n\n` +
            `Хотите использовать этот адрес или указать свой?`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✅ Использовать стандартный', callback_data: 'use_default_address' }],
                        [{ text: '✏️ Указать свой адрес', callback_data: 'use_custom_address' }]
                    ]
                }
            }
        );
        return;
    }

    // Обработка кастомного адреса
    if (users.userStates[userId] === 'waiting_for_custom_address') {
        const tempData = users.tempLinkData?.[userId];
        if (!tempData) {
            bot.sendMessage(chatId, '❌ Данные не найдены. Начните создание ссылки заново.');
            delete users.userStates[userId];
            saveUsers();
            return;
        }

        const customAddress = text.trim();

        if (customAddress.length < 10) {
            bot.sendMessage(chatId,
                `❌ *Адрес слишком короткий!*\n\n` +
                `Введите полный адрес.\n` +
                `*Пример:* г. Москва, ул. Ленина, 10`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // Создаем ссылку с кастомными данными
        const customPrices = tempData.customPrices || null;
        createLinkForUser(userId, tempData, customPrices, customAddress, chatId, null);
        return;
    }

    // Обработка заявки на доступ - шаг 1: откуда узнали
    if (users.userStates[userId] === 'waiting_for_application_source') {
        if (!users.applications) users.applications = {};
        users.applications[userId] = { source: text.trim() };
        users.userStates[userId] = 'waiting_for_application_experience';
        saveUsers();

        bot.sendMessage(chatId,
            `2️⃣ *Расскажите о вашем опыте работы*\n\n` +
            `_Опишите ваш опыт (можно кратко):_`,
            { parse_mode: 'Markdown' }
        );
        return;
    }

    // Обработка заявки на доступ - шаг 2: опыт
    if (users.userStates[userId] === 'waiting_for_application_experience') {
        users.applications[userId].experience = text.trim();
        users.userStates[userId] = 'waiting_for_application_about';
        saveUsers();

        bot.sendMessage(chatId,
            `3️⃣ *Расскажите о себе*\n\n` +
            `_Немного информации о вас:_`,
            { parse_mode: 'Markdown' }
        );
        return;
    }

    // Обработка заявки на доступ - шаг 3: о себе
    if (users.userStates[userId] === 'waiting_for_application_about') {
        users.applications[userId].about = text.trim();
        users.applications[userId].timestamp = Date.now();

        // Добавляем в список ожидания
        users.pending.push(userId);
        delete users.userStates[userId];
        saveUsers();

        bot.sendMessage(chatId,
            `✅ *Заявка отправлена!*\n\n` +
            `Спасибо за заполнение анкеты.\n` +
            `Администратор рассмотрит вашу заявку в ближайшее время.`,
            { parse_mode: 'Markdown' }
        );

        // Уведомляем всех админов
        const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
        const app = users.applications[userId];
        users.admins.forEach(adminId => {
            bot.sendMessage(
                adminId,
                `🔔 *Новая заявка на доступ*\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `👤 *Пользователь:* ${username}\n` +
                `🆔 *ID:* \`${userId}\`\n\n` +
                `📍 *Откуда узнал:* ${app.source}\n` +
                `💼 *Опыт:* ${app.experience}\n` +
                `👨‍💼 *О себе:* ${app.about}\n\n` +
                `_Используйте команды для управления:_\n` +
                `/approve ${userId}\n` +
                `/reject ${userId}`,
                { parse_mode: 'Markdown' }
            );
        });
        return;
    }

    // Обработка кастомных цен
    if (users.userStates[userId] === 'waiting_for_custom_prices') {
        const tempData = users.tempLinkData?.[userId];
        if (!tempData) {
            bot.sendMessage(chatId, '❌ Данные не найдены. Начните создание ссылки заново.');
            delete users.userStates[userId];
            saveUsers();
            return;
        }

        // Парсим цены
        const pricesArray = text.trim().split(',').map(p => parseInt(p.trim()));

        if (pricesArray.length !== 3 || pricesArray.some(p => isNaN(p) || p <= 0)) {
            bot.sendMessage(chatId,
                `❌ *Неверный формат!*\n\n` +
                `Введите три числа через запятую.\n` +
                `*Пример:* 5000, 4500, 4000`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const customPrices = {
            baikal: pricesArray[0],
            taiga: pricesArray[1],
            banya: pricesArray[2]
        };

        // Сохраняем кастомные цены во временные данные
        tempData.customPrices = customPrices;

        // Переходим к выбору адреса
        users.userStates[userId] = 'waiting_for_address_choice';
        saveUsers();

        const cityData = tempData.cityData;
        bot.sendMessage(chatId,
            `✅ *Цены установлены*\n\n` +
            `• Байкал: ${customPrices.baikal}₽/час\n` +
            `• Тайга: ${customPrices.taiga}₽/час\n` +
            `• Русская баня: ${customPrices.banya}₽/час\n\n` +
            `📍 *Адрес по умолчанию:*\n${cityData.address}\n\n` +
            `Хотите использовать этот адрес или указать свой?`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✅ Использовать стандартный', callback_data: 'use_default_address' }],
                        [{ text: '✏️ Указать свой адрес', callback_data: 'use_custom_address' }]
                    ]
                }
            }
        );
        return;
    }

    // Обработка кастомного адреса
    if (users.userStates[userId] === 'waiting_for_custom_address') {
        const tempData = users.tempLinkData?.[userId];
        if (!tempData) {
            bot.sendMessage(chatId, '❌ Данные не найдены. Начните создание ссылки заново.');
            delete users.userStates[userId];
            saveUsers();
            return;
        }

        const customAddress = text.trim();

        if (customAddress.length < 10) {
            bot.sendMessage(chatId,
                `❌ *Адрес слишком короткий!*\n\n` +
                `Введите полный адрес.\n` +
                `*Пример:* г. Москва, ул. Ленина, 10`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // Создаем ссылку с кастомными данными
        const customPrices = tempData.customPrices || null;
        createLinkForUser(userId, tempData, customPrices, customAddress, chatId, null);
        return;
    }

    if (users.userStates[userId] !== 'waiting_for_city') {
        // Пользователь не в режиме создания ссылки
        bot.sendMessage(chatId, '💡 Для создания ссылки нажмите кнопку "📝 Создать ссылку"');
        return;
    }

    // Нормализуем название города для URL
    let cityKey = transliterate(text.trim().toLowerCase().replace(/\s+/g, '-'));
    // Дополнительная очистка от мягкого и твердого знаков
    cityKey = cityKey.replace(/[ьъ]/g, '');
    const cityName = text.trim();

    // Проверяем, есть ли город в базе
    let city = cities[cityKey];

    // Если не найден по ключу, ищем по русскому названию
    if (!city) {
        const normalizedInput = cityName.toLowerCase().trim();

        // Ищем город по русскому названию
        for (const [key, cityData] of Object.entries(cities)) {
            if (cityData.name.toLowerCase() === normalizedInput) {
                cityKey = key;
                city = cityData;
                break;
            }
        }
    }

    if (!city) {
        // Город не найден - отправляем текстовое сообщение
        bot.sendMessage(chatId, '❌ Город не найден в базе данных.');
        return;
    }

    // Проверяем, не зарезервирован ли город другим воркером
    if (isCityReserved(cityKey, userId)) {
        const reservation = users.cityReservations[cityKey];
        const reservedBy = reservation.userId;
        const reservedByName = users.workerInfo?.[cityKey]?.name || `ID: ${reservedBy}`;
        const timeLeft = Math.ceil((24 * 60 * 60 * 1000 - (Date.now() - reservation.timestamp)) / (60 * 60 * 1000));

        bot.sendMessage(chatId,
            `⛔️ *Город уже зарезервирован!*\n\n` +
            `🏙 *Город:* ${cityName}\n` +
            `👤 *Зарезервирован:* ${reservedByName}\n` +
            `⏰ *Осталось времени:* ~${timeLeft} ч\n\n` +
            `Выберите другой город или дождитесь окончания резервации.`,
            { parse_mode: 'Markdown' }
        );
        return;
    }

    // Проверяем лимит городов для воркера
    const reservedCount = getUserReservedCitiesCount(userId);
    if (reservedCount >= 3) {
        bot.sendMessage(chatId,
            `⛔️ *Достигнут лимит городов!*\n\n` +
            `У вас уже зарезервировано максимальное количество городов (3).\n\n` +
            `Дождитесь окончания резервации одного из городов или свяжитесь с администратором.`,
            { parse_mode: 'Markdown' }
        );
        return;
    }

    // Резервируем город
    reserveCity(cityKey, userId, cityName);

    // Сохраняем временные данные для создания ссылки
    if (!users.tempLinkData) users.tempLinkData = {};
    users.tempLinkData[userId] = {
        cityKey: cityKey,
        cityName: cityName,
        cityData: city
    };

    // Переходим к выбору цен
    users.userStates[userId] = 'waiting_for_prices_choice';
    saveUsers();

    bot.sendMessage(chatId,
        `✅ *Город найден: ${city.name}*\n\n` +
        `💰 *Цены по умолчанию:*\n` +
        `• Байкал: ${city.prices.baikal}₽/час\n` +
        `• Тайга: ${city.prices.taiga}₽/час\n` +
        `• Русская баня: ${city.prices.banya}₽/час\n\n` +
        `Хотите использовать эти цены или указать свои?`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '✅ Использовать стандартные', callback_data: 'use_default_prices' }],
                    [{ text: '✏️ Указать свои цены', callback_data: 'use_custom_prices' }]
                ]
            }
        }
    );
});

// Функция транслитерации
function transliterate(text) {
    const ru = {
        'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
        'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
        'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
        'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch',
        'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya'
    };

    return text.split('').map(char => ru[char] || char).join('');
}

// Экспорт бота для использования в server.js
module.exports = { bot, users, saveUsers };

// Запуск бота только если файл запущен напрямую
if (require.main === module) {
    console.log('🤖 Telegram бот запущен...');
}
