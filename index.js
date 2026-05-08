const TelegramBot = require('node-telegram-bot-api');
const GameManager = require('./gameManager');

const TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const bot = new TelegramBot(TOKEN, { polling: true });
const games = new GameManager(bot);

// ─── Commands ───────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🎭 *Добро пожаловать в Мафию!*\n\n` +
    `*Команды:*\n` +
    `/newgame — создать новую игру\n` +
    `/join — присоединиться к игре\n` +
    `/startgame — начать игру (только создатель)\n` +
    `/roles — список всех ролей\n` +
    `/help — помощь\n\n` +
    `_Добавьте бота в группу и начните игру!_`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/newgame/, (msg) => {
  games.createGame(msg.chat.id, msg.from);
});

bot.onText(/\/join/, (msg) => {
  games.joinGame(msg.chat.id, msg.from);
});

bot.onText(/\/startgame/, (msg) => {
  games.startGame(msg.chat.id, msg.from.id);
});

bot.onText(/\/endgame/, (msg) => {
  games.endGame(msg.chat.id, msg.from.id);
});

bot.onText(/\/roles/, (msg) => {
  const { ROLES } = require('./roles.js');
  let text = `🎭 *Все роли в игре:*\n\n`;
  for (const [key, role] of Object.entries(ROLES)) {
    text += `${role.emoji} *${role.name}* — ${role.description}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `📖 *Как играть в Мафию:*\n\n` +
    `1️⃣ Добавьте бота в группу\n` +
    `2️⃣ Напишите /newgame для создания игры\n` +
    `3️⃣ Игроки пишут /join чтобы вступить (минимум 5)\n` +
    `4️⃣ Создатель пишет /startgame\n` +
    `5️⃣ Бот раздаёт роли в личку\n\n` +
    `*Ночь:* Мафия голосует убить, спец. роли используют способности\n` +
    `*День:* Все обсуждают и голосуют за подозреваемого\n\n` +
    `*Победа Мирных:* все мафиози устранены\n` +
    `*Победа Мафии:* мафия ≥ мирных`,
    { parse_mode: 'Markdown' }
  );
});

// ─── Callback queries (inline buttons) ───────────────────────────────────────

bot.on('callback_query', (query) => {
  games.handleCallback(query);
});

// ─── Private messages (night actions) ────────────────────────────────────────

bot.on('message', (msg) => {
  if (msg.chat.type === 'private' && msg.text && !msg.text.startsWith('/')) {
    games.handlePrivateMessage(msg);
  }
});

console.log('🎭 Mafia Bot запущен!');