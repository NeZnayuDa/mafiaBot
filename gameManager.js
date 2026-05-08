const { Game, PHASE, NIGHT_DURATION, DAY_DURATION, VOTE_DURATION } = require('./game');
const { ROLES } = require('./roles');

class GameManager {
  constructor(bot) {
    this.bot   = bot;
    this.games = {}; // chatId -> Game
  }

  // ─── Create / Join / Start ─────────────────────────────────────────────────

  createGame(chatId, user) {
    if (this.games[chatId] && this.games[chatId].phase !== PHASE.ENDED) {
      return this.bot.sendMessage(chatId, '⚠️ Игра уже создана! Напишите /join чтобы вступить.');
    }
    const game = new Game(chatId, user, this.bot);
    game.addPlayer(user);
    this.games[chatId] = game;
    this.bot.sendMessage(chatId,
      `🎭 *Новая игра Мафии создана!*\n\n` +
      `Создатель: *${user.first_name}*\n` +
      `Игроков: 1\n\n` +
      `Напишите /join чтобы вступить.\n` +
      `Минимум 5 игроков. Создатель пишет /startgame.`,
      { parse_mode: 'Markdown' }
    );
  }

  joinGame(chatId, user) {
    const game = this.games[chatId];
    if (!game) return this.bot.sendMessage(chatId, '❌ Нет активной игры. Напишите /newgame.');
    const result = game.addPlayer(user);
    if (result === 'already') return this.bot.sendMessage(chatId, '⚠️ Вы уже в игре!');
    if (result === 'started') return this.bot.sendMessage(chatId, '❌ Игра уже началась.');
    this.bot.sendMessage(chatId,
      `✅ *${user.first_name}* вступил в игру!\n` +
      `Игроков: *${game.players.length}*`,
      { parse_mode: 'Markdown' }
    );
  }

  async startGame(chatId, userId) {
    const game = this.games[chatId];
    if (!game) return this.bot.sendMessage(chatId, '❌ Нет активной игры.');
    if (game.creator.id !== userId) return this.bot.sendMessage(chatId, '❌ Только создатель может начать игру.');
    if (game.players.length < 5) return this.bot.sendMessage(chatId, '❌ Нужно минимум 5 игроков!');

    game.assignRoles();
    await this.bot.sendMessage(chatId,
      `🎭 *Игра началась!* Роли розданы.\n\n` +
      `Проверьте личные сообщения от бота — там ваша роль!\n\n` +
      `Игроков: *${game.players.length}*`,
      { parse_mode: 'Markdown' }
    );

    // Отправить роли в личку
    for (const player of game.players) {
      await this.sendRole(player, game);
    }

    // Начинаем первую ночь через 3 сек
    setTimeout(() => this.beginNight(chatId), 3000);
  }

  endGame(chatId, userId) {
    const game = this.games[chatId];
    if (!game) return;
    if (game.creator.id !== userId) return this.bot.sendMessage(chatId, '❌ Только создатель может завершить игру.');
    game.clearTimer();
    game.phase = PHASE.ENDED;
    delete this.games[chatId];
    this.bot.sendMessage(chatId, '🛑 Игра принудительно завершена.');
  }

  // ─── Role DM ───────────────────────────────────────────────────────────────

  async sendRole(player, game) {
    const role = ROLES[player.roleKey];
    let text = `🎭 *Ваша роль: ${role.emoji} ${role.name}*\n\n${role.description}`;

    if (player.roleKey === 'EXECUTIONER' && player.executionerTarget) {
      const target = game.getPlayer(player.executionerTarget);
      text += `\n\n🎯 Ваша цель: *${target?.name || '?'}*`;
    }

    // Мафия видит друг друга
    if (role.team === 'mafia') {
      const teammates = game.players.filter(p => p.id !== player.id && ROLES[p.roleKey]?.team === 'mafia');
      if (teammates.length) {
        text += `\n\n👥 Ваша команда:\n` + teammates.map(t => `• ${t.name} — ${ROLES[t.roleKey].emoji} ${ROLES[t.roleKey].name}`).join('\n');
      }
    }

    try {
      await this.bot.sendMessage(player.id, text, { parse_mode: 'Markdown' });
    } catch {
      this.bot.sendMessage(game.chatId, `⚠️ Не удалось отправить роль ${player.name}. Напишите боту в личку сначала!`);
    }
  }

  // ─── Night ─────────────────────────────────────────────────────────────────

  async beginNight(chatId) {
    const game = this.games[chatId];
    if (!game || game.phase === PHASE.ENDED) return;

    game.startNight();

    await this.bot.sendMessage(chatId,
      `🌙 *Ночь ${game.day} наступила...*\n\n` +
      `Город засыпает. Проверьте личные сообщения и выполните своё ночное действие!\n\n` +
      `⏳ У вас *45 секунд*.`,
      { parse_mode: 'Markdown' }
    );

    // Разослать ночные кнопки в личку
    for (const player of game.getAlivePlayers()) {
      await this.sendNightAction(player, game);
    }

    game.timer = setTimeout(() => this.resolveNightAndBeginDay(chatId), NIGHT_DURATION);
  }

  async sendNightAction(player, game) {
    const role = ROLES[player.roleKey];
    if (!role.nightAction) return;

    const alive = game.getAlivePlayers().filter(p => p.id !== player.id);

    // Ветеран — уйти в засаду или нет
    if (player.roleKey === 'VETERAN') {
      if (player.alertsLeft <= 0) {
        return this.bot.sendMessage(player.id, '🪖 У вас не осталось засад.').catch(() => {});
      }
      const keyboard = {
        inline_keyboard: [[
          { text: `🚨 Уйти в засаду (осталось: ${player.alertsLeft})`, callback_data: `night:${game.chatId}:alert` },
          { text: '😴 Пропустить', callback_data: `night:${game.chatId}:skip` }
        ]]
      };
      return this.bot.sendMessage(player.id, '🪖 *Ваш ход, Ветеран!*\nУйти в засаду?', { parse_mode: 'Markdown', reply_markup: keyboard }).catch(() => {});
    }

    // Бдительный
    if (player.roleKey === 'VIGILANTE') {
      if (player.vigilanteUsed) return this.bot.sendMessage(player.id, '🏹 Вы уже использовали свой выстрел.').catch(() => {});
    }

    // Мафия — общий выбор цели
    if (['MAFIA', 'GODFATHER', 'YAKUZA'].includes(player.roleKey)) {
      const targets = alive.filter(p => ROLES[p.roleKey]?.team !== 'mafia');
      const keyboard = {
        inline_keyboard: targets.map(t => ([{
          text: `${t.name}`,
          callback_data: `night:${game.chatId}:kill:${t.id}`
        }]))
      };
      keyboard.inline_keyboard.push([{ text: '😴 Пропустить', callback_data: `night:${game.chatId}:skip` }]);
      return this.bot.sendMessage(player.id, `🔫 *Ваш ход!*\nВыберите жертву:`, { parse_mode: 'Markdown', reply_markup: keyboard }).catch(() => {});
    }

    // Поджигатель
    if (player.roleKey === 'ARSONIST') {
      const buttons = alive.map(t => ([{
        text: `💧 Облить: ${t.name}`,
        callback_data: `night:${game.chatId}:douse:${t.id}`
      }]));
      buttons.push([{ text: '🔥 Поджечь ВСЕХ облитых', callback_data: `night:${game.chatId}:ignite:0` }]);
      buttons.push([{ text: '😴 Пропустить', callback_data: `night:${game.chatId}:skip` }]);
      return this.bot.sendMessage(player.id, `🔥 *Ваш ход, Поджигатель!*`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }).catch(() => {});
    }

    // Детектив и Ведьма — нужно два целевых
    if (player.roleKey === 'DETECTIVE') {
      return this.bot.sendMessage(player.id, `🕵️ Введите в чат два имени (или номера из списка). Скоро будут кнопки...\n\n_Функция: сравнить двух игроков._`, { parse_mode: 'Markdown' }).catch(() => {});
    }

    // Амнезиак — выбрать роль мёртвого
    if (player.roleKey === 'AMNESIAC' && !player.roleChosen) {
      if (!game.deadPlayers.length) return this.bot.sendMessage(player.id, '🌀 Пока нет мёртвых чтобы вспомнить роль.').catch(() => {});
      const buttons = game.deadPlayers.map(d => ([{
        text: `${ROLES[d.roleKey]?.emoji} ${ROLES[d.roleKey]?.name} (${d.name})`,
        callback_data: `night:${game.chatId}:remember:${d.roleKey}`
      }]));
      return this.bot.sendMessage(player.id, `🌀 *Вспомните роль!*`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }).catch(() => {});
    }

    // Медиум
    if (player.roleKey === 'MEDIUM' && !player.mediumUsed && game.deadPlayers.length) {
      const buttons = game.deadPlayers.map(d => ([{
        text: d.name,
        callback_data: `night:${game.chatId}:seance:${d.id}`
      }]));
      buttons.push([{ text: '😴 Пропустить', callback_data: `night:${game.chatId}:skip` }]);
      return this.bot.sendMessage(player.id, `🔮 *Поговорить с мёртвым:*`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }).catch(() => {});
    }

    // Мэр — раскрыться
    if (player.roleKey === 'MAYOR' && !player.revealed) {
      const keyboard = {
        inline_keyboard: [[
          { text: '🏛️ Раскрыться! (голос ×3)', callback_data: `night:${game.chatId}:reveal` },
          { text: '😴 Пропустить', callback_data: `night:${game.chatId}:skip` }
        ]]
      };
      return this.bot.sendMessage(player.id, '🏛️ *Вы хотите раскрыться?*\nВаш голос будет стоить 3, но мафия будет знать вас.', { parse_mode: 'Markdown', reply_markup: keyboard }).catch(() => {});
    }

    // Обычный выбор цели (Шериф, Доктор, Телохранитель, Эскорт, Следователь, Бдительный)
    const actionLabel = role.actionLabel || 'Действие';
    const keyboard = {
      inline_keyboard: alive.map(t => ([{
        text: t.name,
        callback_data: `night:${game.chatId}:target:${t.id}`
      }]))
    };
    keyboard.inline_keyboard.push([{ text: '😴 Пропустить', callback_data: `night:${game.chatId}:skip` }]);
    this.bot.sendMessage(player.id,
      `${role.emoji} *${actionLabel}:* выберите цель:`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    ).catch(() => {});
  }

  // ─── Night resolution ──────────────────────────────────────────────────────

  async resolveNightAndBeginDay(chatId) {
    const game = this.games[chatId];
    if (!game || game.phase === PHASE.ENDED) return;
    game.clearTimer();

    const { killed, messages } = game.resolveNight();

    let report = `☀️ *День ${game.day} начался!*\n\n`;

    if (killed.length === 0) {
      report += `😮 Этой ночью никто не погиб!\n`;
    } else {
      report += `💀 *Ночью погибли:*\n`;
      killed.forEach(p => {
        const role = ROLES[p.roleKey];
        report += `• ${p.name} — ${role.emoji} *${role.name}*\n`;
      });
    }

    if (messages.length) {
      report += `\n` + messages.join('\n');
    }

    await this.bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });

    // Проверка победы
    const win = game.checkWin();
    if (win) return this.announceWin(chatId, win);

    // Список живых с кнопками голосования
    game.startDay();
    const aliveList = game.getAlivePlayers().map((p, i) => `${i + 1}. ${p.name}`).join('\n');
    await this.bot.sendMessage(chatId,
      `💬 *Обсуждайте! Кто из них мафия?*\n\n*Живые игроки:*\n${aliveList}\n\n⏳ *90 секунд на обсуждение*, затем голосование.`,
      { parse_mode: 'Markdown' }
    );

    game.timer = setTimeout(() => this.beginVoting(chatId), DAY_DURATION);
  }

  // ─── Voting ────────────────────────────────────────────────────────────────

  async beginVoting(chatId) {
    const game = this.games[chatId];
    if (!game || game.phase === PHASE.ENDED) return;
    game.clearTimer();
    game.startVoting();

    const alive = game.getAlivePlayers();
    const keyboard = {
      inline_keyboard: [
        ...alive.map(p => ([{
          text: p.name,
          callback_data: `vote:${chatId}:${p.id}`
        }])),
        [{ text: '🚫 Никого (пропустить)', callback_data: `vote:${chatId}:skip` }]
      ]
    };

    await this.bot.sendMessage(chatId,
      `⚖️ *Голосование!*\nКого казнить? У вас *30 секунд*.`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );

    game.timer = setTimeout(() => this.resolveVoting(chatId), VOTE_DURATION);
  }

  async resolveVoting(chatId) {
    const game = this.games[chatId];
    if (!game || game.phase === PHASE.ENDED) return;
    game.clearTimer();

    const result = game.tallyVotes();

    if (!result) {
      await this.bot.sendMessage(chatId, `🔔 *Ничья в голосовании!* Никто не казнён.\n\nНаступает ночь...`, { parse_mode: 'Markdown' });
    } else {
      const lynched = game.lynch(result.targetId);
      if (lynched) {
        const role = ROLES[lynched.roleKey];

        // Шут — побеждает если казнён
        if (lynched.roleKey === 'JESTER') {
          await this.bot.sendMessage(chatId,
            `🃏 *${lynched.name}* был казнён!\n\nОН БЫЛ *ШУТОМ*! 🃏\n\n🎉 *Шут победил — его целью и была собственная казнь!*`,
            { parse_mode: 'Markdown' }
          );
          return this.endGameCleanup(chatId, { winner: 'neutral', role: 'JESTER', player: lynched });
        }

        // Палач — цель казнена?
        const executor = game.players.find(p => p.roleKey === 'EXECUTIONER' && p.executionerTarget === lynched.id);
        if (executor && executor.alive) {
          await this.bot.sendMessage(chatId,
            `⚖️ *${lynched.name}* был казнён! (${role.emoji} ${role.name})\n\n*${executor.name}* (⚖️ Палач) добился казни своей цели и побеждает!`,
            { parse_mode: 'Markdown' }
          );
        } else {
          await this.bot.sendMessage(chatId,
            `⚖️ *${lynched.name}* был казнён!\nРоль: ${role.emoji} *${role.name}*`,
            { parse_mode: 'Markdown' }
          );
        }
      }
    }

    const win = game.checkWin();
    if (win) return this.announceWin(chatId, win);

    setTimeout(() => this.beginNight(chatId), 3000);
  }

  // ─── Callback handler ──────────────────────────────────────────────────────

  async handleCallback(query) {
    const data   = query.data;
    const userId = query.from.id;
    const chatId = query.message.chat.id;

    // Голосование в группе
    if (data.startsWith('vote:')) {
      const parts = data.split(':');
      const gameChatId = parseInt(parts[1]);
      const targetId   = parts[2] === 'skip' ? 'skip' : parseInt(parts[2]);
      const game = this.games[gameChatId];
      if (!game || game.phase !== PHASE.VOTING) return this.bot.answerCallbackQuery(query.id, { text: 'Голосование не активно.' });
      if (!game.getPlayer(userId)?.alive) return this.bot.answerCallbackQuery(query.id, { text: 'Вы мертвы.' });
      if (targetId !== 'skip') {
        game.votes[userId] = targetId;
        this.bot.answerCallbackQuery(query.id, { text: '✅ Голос принят!' });
      } else {
        delete game.votes[userId];
        this.bot.answerCallbackQuery(query.id, { text: '🚫 Вы воздержались.' });
      }
      return;
    }

    // Ночные действия (в личке)
    if (data.startsWith('night:')) {
      const parts    = data.split(':');
      const gameChatId = parseInt(parts[1]);
      const action   = parts[2];
      const param    = parts[3];
      const game = this.games[gameChatId];
      if (!game || game.phase !== PHASE.NIGHT) return this.bot.answerCallbackQuery(query.id, { text: 'Сейчас не ночь.' });
      const player = game.getPlayer(userId);
      if (!player || !player.alive) return this.bot.answerCallbackQuery(query.id, { text: 'Вы не в игре или мертвы.' });

      if (action === 'skip') {
        this.bot.answerCallbackQuery(query.id, { text: '😴 Вы пропустили ночь.' });
        return;
      }

      if (action === 'kill') {
        game.nightActions[userId] = { type: 'kill', target: parseInt(param) };
        this.bot.answerCallbackQuery(query.id, { text: `🔫 Цель выбрана!` });
      } else if (action === 'target') {
        game.nightActions[userId] = { type: 'target', target: parseInt(param) };
        this.bot.answerCallbackQuery(query.id, { text: `✅ Действие выполнено!` });
        // Сразу обработать Шерифа
        if (player.roleKey === 'SHERIFF') {
          const target = game.getPlayer(parseInt(param));
          const role   = ROLES[target?.roleKey];
          const result = (role?.appearsInnocent || role?.team === 'town' || role?.team === 'neutral') ? '✅ Мирный' : '🔴 МАФИЯ!';
          this.bot.sendMessage(userId, `🔍 Проверка ${target?.name}: *${result}*`, { parse_mode: 'Markdown' }).catch(() => {});
        }
        if (player.roleKey === 'INVESTIGATOR') {
          const possibleRoles = ['MAFIA', 'SHERIFF', 'DOCTOR', 'DETECTIVE'];
          const rand = possibleRoles[Math.floor(Math.random() * possibleRoles.length)];
          const actual = ROLES[game.getPlayer(parseInt(param))?.roleKey];
          this.bot.sendMessage(userId, `📋 Ваш подозреваемый мог быть: *${actual?.name}* или *${ROLES[rand]?.name}*`, { parse_mode: 'Markdown' }).catch(() => {});
        }
        if (player.roleKey === 'MEDIUM') {
          player.mediumUsed = true;
        }
      } else if (action === 'alert') {
        player.onAlert = true;
        player.alertsLeft--;
        game.nightActions[userId] = { type: 'alert' };
        this.bot.answerCallbackQuery(query.id, { text: `🚨 Вы в засаде!` });
      } else if (action === 'douse') {
        if (!player.doused) player.doused = [];
        player.doused.push(parseInt(param));
        game.nightActions[userId] = { type: 'douse', subtype: 'douse', target: parseInt(param) };
        this.bot.answerCallbackQuery(query.id, { text: `💧 Облит!` });
      } else if (action === 'ignite') {
        game.nightActions[userId] = { type: 'ignite', subtype: 'ignite', target: 0 };
        this.bot.answerCallbackQuery(query.id, { text: `🔥 Поджигаем!` });
      } else if (action === 'reveal') {
        player.revealed = true;
        player.voteWeight = 3;
        game.nightActions[userId] = { type: 'reveal' };
        this.bot.sendMessage(gameChatId, `🏛️ *${player.name}* раскрывается как *Мэр*! Его голос теперь стоит 3.`, { parse_mode: 'Markdown' });
        this.bot.answerCallbackQuery(query.id, { text: `🏛️ Вы раскрылись!` });
      } else if (action === 'seance') {
        const dead = game.deadPlayers.find(d => d.id === parseInt(param));
        if (dead) {
          const role = ROLES[dead.roleKey];
          this.bot.sendMessage(userId, `🔮 Дух *${dead.name}* говорит: "Я был *${role.emoji} ${role.name}*"`, { parse_mode: 'Markdown' }).catch(() => {});
          player.mediumUsed = true;
        }
        this.bot.answerCallbackQuery(query.id, { text: '🔮 Связь установлена!' });
      } else if (action === 'remember') {
        player.roleKey  = param;
        player.roleDef  = { ...ROLES[param] };
        player.roleChosen = true;
        const role = ROLES[param];
        this.bot.sendMessage(userId, `🌀 Вы вспомнили! Теперь вы *${role.emoji} ${role.name}*`, { parse_mode: 'Markdown' }).catch(() => {});
        this.bot.answerCallbackQuery(query.id, { text: `✅ Роль получена!` });
      }

      return;
    }

    this.bot.answerCallbackQuery(query.id);
  }

  handlePrivateMessage(msg) {
    // Можно расширить для детектива / ведьмы (два таргета через текст)
  }

  // ─── Win ───────────────────────────────────────────────────────────────────

  async announceWin(chatId, win) {
    const game = this.games[chatId];
    if (!game) return;

    let text = '';
    if (win.winner === 'town') {
      text = `🎉 *ГОРОД ПОБЕДИЛ!*\n\nВся мафия уничтожена. Мирные жители в безопасности!`;
    } else if (win.winner === 'mafia') {
      text = `🔫 *МАФИЯ ПОБЕДИЛА!*\n\nГород пал под контролем преступников...`;
    } else if (win.winner === 'neutral') {
      const role = ROLES[win.role];
      text = `${role?.emoji} *${role?.name?.toUpperCase()} ПОБЕДИЛ!*\n\n*${win.player?.name}* достиг своей цели!`;
    }

    text += `\n\n*Все роли:*\n`;
    game.players.forEach(p => {
      const role = ROLES[p.roleKey];
      text += `• ${p.name} — ${role?.emoji} ${role?.name}\n`;
    });

    await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    this.endGameCleanup(chatId, win);
  }

  endGameCleanup(chatId, win) {
    const game = this.games[chatId];
    if (!game) return;
    game.clearTimer();
    game.phase = PHASE.ENDED;
    delete this.games[chatId];
  }
}

module.exports = GameManager;