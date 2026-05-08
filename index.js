const TelegramBot = require('node-telegram-bot-api');
const GameManager = require('./gameManager');

const TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const bot = new TelegramBot(TOKEN, { polling: true });
const games = new GameManager(bot);

// ─── Проверка на админа группы ───────────────────────────────────────────────

async function isAdmin(chatId, userId) {
  try {
    const member = await bot.getChatMember(chatId, userId);
    return ['administrator', 'creator'].includes(member.status);
  } catch {
    return false;
  }
}

async function checkAdmin(msg) {
  if (msg.chat.type === 'private') return true;
  const admin = await isAdmin(msg.chat.id, msg.from.id);
  if (!admin) {
    bot.sendMessage(msg.chat.id,
      `❌ *${msg.from.first_name}*, эта команда только для администраторов группы!`,
      { parse_mode: 'Markdown' }
    );
  }
  return admin;
}

// ─── Commands ────────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🎭 *Добро пожаловать в Мафию!*\n\n` +
    `*Команды:*\n` +
    `/newgame — создать новую игру _(только админ)_\n` +
    `/join — присоединиться к игре\n` +
    `/startgame — начать игру _(только админ)_\n` +
    `/endgame — завершить игру _(только админ)_\n` +
    `/roles — список всех ролей\n` +
    `/help — помощь\n\n` +
    `_Добавьте бота в группу и начните игру!_`,
    { parse_mode: 'Markdown' }
  );
});

// ── Только для админов ───────────────────────────────────────────────────────

bot.onText(/\/newgame/, async (msg) => {
  if (!await checkAdmin(msg)) return;
  games.createGame(msg.chat.id, msg.from);
});

bot.onText(/\/startgame/, async (msg) => {
  if (!await checkAdmin(msg)) return;
  games.startGame(msg.chat.id, msg.from.id);
});

bot.onText(/\/endgame/, async (msg) => {
  if (!await checkAdmin(msg)) return;
  games.endGame(msg.chat.id, msg.from.id);
});

// ── Доступно всем ────────────────────────────────────────────────────────────

bot.onText(/\/join/, (msg) => {
  games.joinGame(msg.chat.id, msg.from);
});

bot.onText(/\/roles/, (msg) => {
  const { ROLES } = require('./roles');
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
    `2️⃣ Админ пишет /newgame для создания игры\n` +
    `3️⃣ Игроки пишут /join чтобы вступить (минимум 5)\n` +
    `4️⃣ Админ пишет /startgame\n` +
    `5️⃣ Бот раздаёт роли в личку\n\n` +
    `*Ночь:* Мафия голосует убить, спец. роли используют способности\n` +
    `*День:* Все обсуждают и голосуют за подозреваемого\n\n` +
    `*Победа Мирных:* все мафиози устранены\n` +
    `*Победа Мафии:* мафия ≥ мирных`,
    { parse_mode: 'Markdown' }
  );
});

// ─── Callback queries ─────────────────────────────────────────────────────────

bot.on('callback_query', (query) => {
  games.handleCallback(query);
});

// ─── Private messages ─────────────────────────────────────────────────────────

bot.on('message', (msg) => {
  if (msg.chat.type === 'private' && msg.text && !msg.text.startsWith('/')) {
    games.handlePrivateMessage(msg);
  }
});

console.log('🎭 Mafia Bot запущен!');