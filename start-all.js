require('dotenv').config();

// Запускаем бот
require('./bot.js');

// Запускаем веб-сервер
require('./server.js');

console.log('✅ Все сервисы запущены!');
