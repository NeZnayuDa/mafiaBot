const { ROLES, getRoleDistribution } = require('./roles');

const PHASE = {
  LOBBY: 'lobby',
  NIGHT: 'night',
  DAY: 'day',
  VOTING: 'voting',
  ENDED: 'ended',
};

const NIGHT_DURATION = 45 * 1000;   // 45 секунд
const DAY_DURATION   = 90 * 1000;   // 90 секунд
const VOTE_DURATION  = 30 * 1000;   // 30 секунд

class Game {
  constructor(chatId, creator, bot) {
    this.chatId    = chatId;
    this.creator   = creator;
    this.bot       = bot;
    this.phase     = PHASE.LOBBY;
    this.players   = [];           // { id, name, username, roleKey, ...roleData, alive }
    this.day       = 0;
    this.nightActions = {};        // userId -> action data
    this.votes     = {};           // userId -> targetId
    this.timer     = null;
    this.doused    = new Set();    // для Поджигателя
    this.deadPlayers = [];
    this.executionerTargets = {};  // userId -> targetId
    this.vigilanteUsed = {};
    this.veteranAlerts = {};
    this.mediumUsed = {};
    this.retributionistUsed = {};
  }

  // ─── Players ───────────────────────────────────────────────────────────────

  addPlayer(user) {
    if (this.players.find(p => p.id === user.id)) return 'already';
    if (this.phase !== PHASE.LOBBY) return 'started';
    this.players.push({
      id:       user.id,
      name:     user.first_name + (user.last_name ? ' ' + user.last_name : ''),
      username: user.username || null,
      roleKey:  null,
      alive:    true,
      blocked:  false,
      protected:false,
      guarded:  false,
      guardedBy:null,
    });
    return 'ok';
  }

  getPlayer(id) {
    return this.players.find(p => p.id === id);
  }

  getAlivePlayers() {
    return this.players.filter(p => p.alive);
  }

  getAliveByTeam(team) {
    return this.getAlivePlayers().filter(p => {
      const role = ROLES[p.roleKey];
      return role && role.team === team;
    });
  }

  // ─── Role assignment ───────────────────────────────────────────────────────

  assignRoles() {
    const count = this.players.length;
    const dist  = getRoleDistribution(count);
    const shuffled = [...dist].sort(() => Math.random() - 0.5);

    this.players.forEach((p, i) => {
      const roleKey  = shuffled[i] || 'CIVILIAN';
      const roleDef  = { ...ROLES[roleKey] };
      p.roleKey      = roleKey;
      p.roleDef      = roleDef;

      // Инициализация особых состояний
      if (roleKey === 'VIGILANTE') p.vigilanteUsed = false;
      if (roleKey === 'VETERAN')   p.alertsLeft = 3;
      if (roleKey === 'MEDIUM')    p.mediumUsed = false;
      if (roleKey === 'RETRIBUTIONIST') p.retributionistUsed = false;
      if (roleKey === 'MAYOR') { p.revealed = false; p.voteWeight = 1; }
      if (roleKey === 'ARSONIST') p.doused = [];
      if (roleKey === 'AMNESIAC') p.roleChosen = false;
    });

    // Назначить цель Палачу (случайный мирный)
    const executioners = this.players.filter(p => p.roleKey === 'EXECUTIONER');
    const possibleTargets = this.players.filter(p => {
      const r = ROLES[p.roleKey];
      return r && r.team === 'town';
    });
    executioners.forEach(ex => {
      if (possibleTargets.length) {
        const available = possibleTargets.filter(t => t.id !== ex.id);
        if (available.length) {
          ex.executionerTarget = available[Math.floor(Math.random() * available.length)].id;
        }
      }
    });
  }

  // ─── Night ─────────────────────────────────────────────────────────────────

  startNight() {
    this.phase = PHASE.NIGHT;
    this.day++;
    this.nightActions = {};

    // Сбросить блокировки и защиты
    this.players.forEach(p => {
      p.blocked   = false;
      p.protected = false;
      p.guarded   = false;
      p.guardedBy = null;
      if (p.roleKey === 'VETERAN') p.onAlert = false;
    });
  }

  resolveNight() {
    const deaths   = new Set();
    const saved    = new Set();
    const messages = [];

    // 1. Ветеран — засада
    this.getAlivePlayers()
      .filter(p => p.roleKey === 'VETERAN' && p.onAlert)
      .forEach(vet => {
        // Убить всех, кто ночью "посетил" ветерана
        Object.entries(this.nightActions).forEach(([uid, action]) => {
          if (parseInt(uid) !== vet.id && action.target === vet.id) {
            deaths.add(parseInt(uid));
          }
        });
      });

    // 2. Эскорт — блокировка
    this.getAlivePlayers()
      .filter(p => p.roleKey === 'ESCORT' && this.nightActions[p.id])
      .forEach(escort => {
        const target = this.getPlayer(this.nightActions[escort.id].target);
        if (target && target.alive) target.blocked = true;
      });

    // 3. Ведьма — перенаправление
    this.getAlivePlayers()
      .filter(p => p.roleKey === 'WITCH' && this.nightActions[p.id])
      .forEach(witch => {
        const { target, redirect } = this.nightActions[witch.id];
        const controlled = this.getPlayer(target);
        if (controlled && controlled.alive && this.nightActions[controlled.id]) {
          this.nightActions[controlled.id].target = redirect;
        }
      });

    // 4. Доктор — лечение
    this.getAlivePlayers()
      .filter(p => p.roleKey === 'DOCTOR' && this.nightActions[p.id] && !p.blocked)
      .forEach(doc => {
        const target = this.getPlayer(this.nightActions[doc.id].target);
        if (target && target.alive) target.protected = true;
      });

    // 5. Телохранитель — охрана
    this.getAlivePlayers()
      .filter(p => p.roleKey === 'BODYGUARD' && this.nightActions[p.id] && !p.blocked)
      .forEach(bg => {
        const target = this.getPlayer(this.nightActions[bg.id].target);
        if (target && target.alive) {
          target.guarded  = true;
          target.guardedBy = bg.id;
        }
      });

    // 6. Мафия/Дон/Якудза — убийство
    const mafiaAction = Object.entries(this.nightActions).find(([uid, action]) => {
      const p = this.getPlayer(parseInt(uid));
      return p && !p.blocked && ['MAFIA', 'GODFATHER', 'YAKUZA'].includes(p.roleKey) && action.type === 'kill';
    });
    if (mafiaAction) {
      const [, action] = mafiaAction;
      const target = this.getPlayer(action.target);
      if (target && target.alive) {
        if (target.protected) {
          saved.add(target.id);
          messages.push(`🏥 Доктор спас кого-то этой ночью!`);
        } else if (target.guarded) {
          // Телохранитель погибает вместо подопечного, убивает нападавшего
          const bg = this.getPlayer(target.guardedBy);
          const mafiaMember = this.getPlayer(parseInt(mafiaAction[0]));
          if (bg) deaths.add(bg.id);
          if (mafiaMember) deaths.add(mafiaMember.id);
          messages.push(`🛡️ Телохранитель отдал жизнь, защищая другого!`);
          // Якудза — контратака
        } else if (target.roleKey === 'YAKUZA' && !target.blocked) {
          const attacker = this.getPlayer(parseInt(mafiaAction[0]));
          if (attacker && attacker.roleKey !== 'YAKUZA') deaths.add(attacker.id);
        } else {
          deaths.add(target.id);
        }
      }
    }

    // 7. Серийный убийца
    this.getAlivePlayers()
      .filter(p => p.roleKey === 'SERIALKILLER' && this.nightActions[p.id] && !p.blocked)
      .forEach(sk => {
        const target = this.getPlayer(this.nightActions[sk.id].target);
        if (target && target.alive && !target.protected) {
          if (target.guarded) {
            const bg = this.getPlayer(target.guardedBy);
            if (bg) deaths.add(bg.id);
            deaths.add(sk.id);
          } else {
            deaths.add(target.id);
          }
        }
      });

    // 8. Бдительный (Vigilante)
    this.getAlivePlayers()
      .filter(p => p.roleKey === 'VIGILANTE' && this.nightActions[p.id] && !p.blocked && !p.vigilanteUsed)
      .forEach(vig => {
        const target = this.getPlayer(this.nightActions[vig.id].target);
        vig.vigilanteUsed = true;
        if (target && target.alive && !target.protected) {
          deaths.add(target.id);
          // Если убил мирного — умирает сам
          if (ROLES[target.roleKey]?.team === 'town') {
            messages.push(`😔 Бдительный убил мирного и умер от вины...`);
            deaths.add(vig.id);
          }
        }
      });

    // 9. Поджигатель
    this.getAlivePlayers()
      .filter(p => p.roleKey === 'ARSONIST' && this.nightActions[p.id] && !p.blocked)
      .forEach(ars => {
        const action = this.nightActions[ars.id];
        if (action.subtype === 'douse') {
          if (!ars.doused) ars.doused = [];
          ars.doused.push(action.target);
        } else if (action.subtype === 'ignite') {
          (ars.doused || []).forEach(tid => {
            const t = this.getPlayer(tid);
            if (t && t.alive && !t.protected) deaths.add(tid);
          });
          ars.doused = [];
        }
      });

    // Применяем смерти
    const killed = [];
    deaths.forEach(id => {
      const p = this.getPlayer(id);
      if (p && p.alive) {
        p.alive = false;
        this.deadPlayers.push({ ...p });
        killed.push(p);
      }
    });

    return { killed, messages };
  }

  // ─── Day / voting ──────────────────────────────────────────────────────────

  startDay() {
    this.phase = PHASE.DAY;
    this.votes = {};
  }

  startVoting() {
    this.phase = PHASE.VOTING;
    this.votes = {};
  }

  tallyVotes() {
    const count = {};
    const alive = this.getAlivePlayers();

    Object.entries(this.votes).forEach(([voterId, targetId]) => {
      const voter = this.getPlayer(parseInt(voterId));
      const weight = (voter?.roleKey === 'MAYOR' && voter?.revealed) ? 3 : 1;
      count[targetId] = (count[targetId] || 0) + weight;
    });

    if (!Object.keys(count).length) return null;

    const maxVotes = Math.max(...Object.values(count));
    const candidates = Object.keys(count).filter(id => count[id] === maxVotes);

    if (candidates.length !== 1) return null; // ничья
    return { targetId: parseInt(candidates[0]), votes: maxVotes };
  }

  lynch(targetId) {
    const player = this.getPlayer(targetId);
    if (!player || !player.alive) return null;
    player.alive = false;
    this.deadPlayers.push({ ...player });
    return player;
  }

  // ─── Win check ─────────────────────────────────────────────────────────────

  checkWin() {
    const alive = this.getAlivePlayers();
    const mafiaAlive = this.getAliveByTeam('mafia');
    const townAlive  = this.getAliveByTeam('town');
    const neutralAlive = this.getAliveByTeam('neutral');

    // Серийный убийца или Поджигатель — все остальные мертвы
    const soloWinner = alive.find(p =>
      ['SERIALKILLER', 'ARSONIST'].includes(p.roleKey) && alive.length === 1
    );
    if (soloWinner) return { winner: 'neutral', role: soloWinner.roleKey, player: soloWinner };

    // Мафия победила
    if (mafiaAlive.length >= townAlive.length + neutralAlive.filter(p =>
      !['SERIALKILLER','ARSONIST'].includes(p.roleKey)
    ).length && mafiaAlive.length > 0) {
      return { winner: 'mafia' };
    }

    // Город победил
    if (mafiaAlive.length === 0) {
      // Проверить нейтральных угроз
      const threats = alive.filter(p => ['SERIALKILLER','ARSONIST'].includes(p.roleKey));
      if (threats.length === 0) return { winner: 'town' };
    }

    return null;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  playerList() {
    return this.players
      .map((p, i) => {
        const role = ROLES[p.roleKey];
        const status = p.alive ? '🟢' : '💀';
        return `${status} ${i + 1}. ${p.name}${p.username ? ` (@${p.username})` : ''}` +
               (!p.alive ? ` — ${role?.emoji || ''} ${role?.name || ''}` : '');
      })
      .join('\n');
  }
}

module.exports = { Game, PHASE, NIGHT_DURATION, DAY_DURATION, VOTE_DURATION };