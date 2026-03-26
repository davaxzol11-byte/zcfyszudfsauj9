require('dotenv').config();

// Запускаем бот напрямую (чтобы polling работал)
const { spawn } = require('child_process');
const botProcess = spawn('node', ['bot.js'], { stdio: 'inherit' });

// Даем боту время запуститься перед стартом сервера
setTimeout(() => {
    require('./server.js');
    console.log('✅ Все сервисы запущены!');
}, 1000);
