const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const initSqlJs = require('sql.js/dist/sql-wasm.js');

const app = express();
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DB_PATH = path.join(DATA_DIR, 'app.sqlite');
const SESSION_SECRET = process.env.SESSION_SECRET || 'mini-games-platform-secret';
const DEFAULT_ADMIN_USERNAME = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
const DEFAULT_ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || '123456';
const START_PORT = Number(process.env.PORT || 3000);

const GAME_MAP = {
  snake: '贪吃蛇大作战',
  minesweeper: '扫雷',
  fly: '飞机大战',
  maze: '迷宫小游戏'
};

let SQL = null;
let db = null;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 1000 * 60 * 60 * 12
    }
  })
);

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function persistDatabase() {
  ensureDataDir();
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows[0] || null;
}

function run(sql, params = []) {
  db.run(sql, params);
  persistDatabase();
}

function nowIso() {
  return new Date().toISOString();
}

function validGameKey(gameKey) {
  return Object.prototype.hasOwnProperty.call(GAME_MAP, gameKey);
}

function toPublicUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    username: String(row.username),
    role: String(row.role),
    createdAt: String(row.created_at),
    lastLoginAt: row.last_login_at ? String(row.last_login_at) : null
  };
}

function setSessionUser(req, user) {
  req.session.user = {
    id: Number(user.id),
    username: String(user.username),
    role: String(user.role)
  };
}

function getClientIp(req) {
  return req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
}

function logLoginAttempt(req, payload) {
  run(
    'INSERT INTO login_logs (user_id, username, ip, user_agent, success, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [
      payload.userId || null,
      payload.username || '',
      String(getClientIp(req)).slice(0, 255),
      String(req.headers['user-agent'] || '').slice(0, 255),
      payload.success ? 1 : 0,
      nowIso()
    ]
  );
}

function requireAuthApi(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ message: '未登录，请先登录。' });
  }
  return next();
}

function requireAdminApi(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ message: '未登录，请先登录。' });
  }
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({ message: '只有管理员可以访问该接口。' });
  }
  return next();
}

function requireAuthPage(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/');
  }
  return next();
}

function requireAdminPage(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/');
  }
  if (req.session.user.role !== 'admin') {
    return res.redirect('/game.html');
  }
  return next();
}

async function initDatabase() {
  SQL = await initSqlJs({
    locateFile: (file) => path.join(ROOT_DIR, 'node_modules', 'sql.js', 'dist', file)
  });

  ensureDataDir();

  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      game_key TEXT NOT NULL,
      game_name TEXT NOT NULL,
      score INTEGER NOT NULL,
      duration_seconds REAL,
      result TEXT NOT NULL DEFAULT 'completed',
      meta_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS login_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      ip TEXT,
      user_agent TEXT,
      success INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  const userColumns = queryAll('PRAGMA table_info(users)');
  const hasLastLoginAt = userColumns.some((col) => String(col.name) === 'last_login_at');
  if (!hasLastLoginAt) {
    db.run('ALTER TABLE users ADD COLUMN last_login_at TEXT');
  }

  const admin = queryOne('SELECT * FROM users WHERE username = ?', [DEFAULT_ADMIN_USERNAME]);
  if (!admin) {
    const passwordHash = bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, 10);
    run(
      'INSERT INTO users (username, password_hash, role, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)',
      [DEFAULT_ADMIN_USERNAME, passwordHash, 'admin', nowIso(), null]
    );
  } else {
    persistDatabase();
  }
}

app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

app.get('/game.html', requireAuthPage, (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'game.html'));
});
app.get('/profile.html', requireAuthPage, (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'profile.html'));
});
app.get('/leaderboard.html', requireAuthPage, (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'leaderboard.html'));
});
app.get('/admin.html', requireAdminPage, (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'admin.html'));
});
app.get('/snake.html', requireAuthPage, (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'snake.html'));
});
app.get('/sl.html', requireAuthPage, (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'sl.html'));
});
app.get('/fly.html', requireAuthPage, (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'fly.html'));
});
app.get('/Maze_mobile.html', requireAuthPage, (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'Maze_mobile.html'));
});

app.use('/assets', express.static(path.join(ROOT_DIR, 'assets')));

app.use('/api', (req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

app.post('/api/register', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '').trim();
  const confirmPassword = String(req.body.confirmPassword || '').trim();

  if (!username || !password || !confirmPassword) {
    return res.status(400).json({ message: '请完整填写注册信息。' });
  }
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/.test(username)) {
    return res.status(400).json({ message: '用户名需为 2-20 位，可包含中文、字母、数字和下划线。' });
  }
  if (password.length < 6) {
    return res.status(400).json({ message: '密码至少 6 位。' });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ message: '两次输入的密码不一致。' });
  }
  if (queryOne('SELECT id FROM users WHERE username = ?', [username])) {
    return res.status(409).json({ message: '用户名已存在，请换一个。' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  run(
    'INSERT INTO users (username, password_hash, role, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)',
    [username, passwordHash, 'user', nowIso(), nowIso()]
  );

  const newUser = queryOne('SELECT * FROM users WHERE username = ?', [username]);
  const publicUser = toPublicUser(newUser);
  setSessionUser(req, publicUser);
  logLoginAttempt(req, { success: true, userId: publicUser.id, username: publicUser.username });

  return res.status(201).json({
    message: '注册成功，已自动登录。',
    user: publicUser
  });
});

app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '').trim();

  if (!username || !password) {
    return res.status(400).json({ message: '请输入用户名和密码。' });
  }

  const user = queryOne('SELECT * FROM users WHERE username = ?', [username]);
  if (!user) {
    logLoginAttempt(req, { success: false, username });
    return res.status(401).json({ message: '用户名或密码错误。' });
  }

  const isPasswordCorrect = bcrypt.compareSync(password, String(user.password_hash));
  if (!isPasswordCorrect) {
    logLoginAttempt(req, { success: false, userId: Number(user.id), username });
    return res.status(401).json({ message: '用户名或密码错误。' });
  }

  run('UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso(), Number(user.id)]);
  const freshUser = queryOne('SELECT * FROM users WHERE id = ?', [Number(user.id)]);
  const publicUser = toPublicUser(freshUser);
  setSessionUser(req, publicUser);
  logLoginAttempt(req, { success: true, userId: publicUser.id, username: publicUser.username });

  return res.json({ message: '登录成功。', user: publicUser });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ message: '已退出登录。' });
  });
});

app.get('/api/me', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ message: '未登录。' });
  }

  const user = queryOne('SELECT * FROM users WHERE id = ?', [Number(req.session.user.id)]);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ message: '用户不存在。' });
  }

  return res.json({ user: toPublicUser(user) });
});

app.get('/api/profile', requireAuthApi, (req, res) => {
  const userId = Number(req.session.user.id);
  const user = queryOne('SELECT * FROM users WHERE id = ?', [userId]);
  const stats = queryOne(
    `SELECT
       COUNT(*) AS totalPlays,
       COALESCE(SUM(score), 0) AS totalScore,
       COALESCE(MAX(score), 0) AS bestScore
     FROM scores
     WHERE user_id = ?`,
    [userId]
  ) || { totalPlays: 0, totalScore: 0, bestScore: 0 };

  const bestByGame = queryAll(
    `SELECT game_key AS gameKey, game_name AS gameName, MAX(score) AS bestScore, COUNT(*) AS playCount
     FROM scores
     WHERE user_id = ?
     GROUP BY game_key, game_name
     ORDER BY bestScore DESC, playCount DESC`,
    [userId]
  ).map((row) => ({
    gameKey: String(row.gameKey),
    gameName: String(row.gameName),
    bestScore: Number(row.bestScore),
    playCount: Number(row.playCount)
  }));

  const recentScores = queryAll(
    `SELECT id, game_key AS gameKey, game_name AS gameName, score, duration_seconds AS durationSeconds, result, created_at AS createdAt
     FROM scores
     WHERE user_id = ?
     ORDER BY datetime(created_at) DESC, id DESC
     LIMIT 12`,
    [userId]
  ).map((row) => ({
    id: Number(row.id),
    gameKey: String(row.gameKey),
    gameName: String(row.gameName),
    score: Number(row.score),
    durationSeconds: row.durationSeconds == null ? null : Number(row.durationSeconds),
    result: String(row.result),
    createdAt: String(row.createdAt)
  }));

  return res.json({
    user: toPublicUser(user),
    stats: {
      totalPlays: Number(stats.totalPlays || 0),
      totalScore: Number(stats.totalScore || 0),
      bestScore: Number(stats.bestScore || 0)
    },
    bestByGame,
    recentScores
  });
});

app.get('/api/leaderboard/overview', requireAuthApi, (req, res) => {
  const games = Object.entries(GAME_MAP).map(([gameKey, gameName]) => {
    const best = queryOne(
      `SELECT s.score AS score, u.username AS username
       FROM scores s
       JOIN users u ON u.id = s.user_id
       WHERE s.game_key = ?
       ORDER BY s.score DESC, datetime(s.created_at) ASC, s.id ASC
       LIMIT 1`,
      [gameKey]
    );
    const playCountRow = queryOne('SELECT COUNT(*) AS count FROM scores WHERE game_key = ?', [gameKey]) || { count: 0 };
    return {
      gameKey,
      gameName,
      topScore: best ? Number(best.score) : 0,
      topUsername: best ? String(best.username) : '暂无',
      playCount: Number(playCountRow.count || 0)
    };
  });

  const latest = queryAll(
    `SELECT s.id, s.game_key AS gameKey, s.game_name AS gameName, s.score, s.created_at AS createdAt, u.username
     FROM scores s JOIN users u ON u.id = s.user_id
     ORDER BY datetime(s.created_at) DESC, s.id DESC
     LIMIT 10`
  ).map((row) => ({
    id: Number(row.id),
    gameKey: String(row.gameKey),
    gameName: String(row.gameName),
    score: Number(row.score),
    username: String(row.username),
    createdAt: String(row.createdAt)
  }));

  return res.json({ games, latest });
});

app.get('/api/leaderboard', requireAuthApi, (req, res) => {
  const gameKey = String(req.query.gameKey || 'snake');
  if (!validGameKey(gameKey)) {
    return res.status(400).json({ message: '不支持的游戏类型。' });
  }

  const topRows = queryAll(
    `SELECT s.id, s.score, s.duration_seconds AS durationSeconds, s.result, s.created_at AS createdAt,
            u.username
     FROM scores s
     JOIN users u ON u.id = s.user_id
     WHERE s.game_key = ?
     ORDER BY s.score DESC, datetime(s.created_at) ASC, s.id ASC
     LIMIT 20`,
    [gameKey]
  ).map((row, index) => ({
    rank: index + 1,
    id: Number(row.id),
    username: String(row.username),
    score: Number(row.score),
    durationSeconds: row.durationSeconds == null ? null : Number(row.durationSeconds),
    result: String(row.result),
    createdAt: String(row.createdAt)
  }));

  const myRows = queryAll(
    `SELECT id, score, duration_seconds AS durationSeconds, result, created_at AS createdAt
     FROM scores
     WHERE user_id = ? AND game_key = ?
     ORDER BY score DESC, datetime(created_at) ASC, id ASC
     LIMIT 10`,
    [Number(req.session.user.id), gameKey]
  ).map((row, index) => ({
    rank: index + 1,
    id: Number(row.id),
    score: Number(row.score),
    durationSeconds: row.durationSeconds == null ? null : Number(row.durationSeconds),
    result: String(row.result),
    createdAt: String(row.createdAt)
  }));

  return res.json({
    gameKey,
    gameName: GAME_MAP[gameKey],
    leaderboard: topRows,
    myTop: myRows
  });
});

app.post('/api/scores', requireAuthApi, (req, res) => {
  const gameKey = String(req.body.gameKey || '').trim();
  const scoreValue = Number(req.body.score);
  const durationValue = req.body.durationSeconds == null || req.body.durationSeconds === '' ? null : Number(req.body.durationSeconds);
  const result = String(req.body.result || 'completed').trim() || 'completed';
  const meta = req.body.meta && typeof req.body.meta === 'object' ? req.body.meta : {};

  if (!validGameKey(gameKey)) {
    return res.status(400).json({ message: '不支持的游戏类型。' });
  }
  if (!Number.isFinite(scoreValue) || scoreValue < 0) {
    return res.status(400).json({ message: '成绩必须是不小于 0 的数字。' });
  }
  if (durationValue != null && (!Number.isFinite(durationValue) || durationValue < 0)) {
    return res.status(400).json({ message: '耗时格式不正确。' });
  }

  const safeScore = Math.round(scoreValue);
  const safeDuration = durationValue == null ? null : Number(durationValue.toFixed(2));
  run(
    'INSERT INTO scores (user_id, game_key, game_name, score, duration_seconds, result, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      Number(req.session.user.id),
      gameKey,
      GAME_MAP[gameKey],
      safeScore,
      safeDuration,
      result,
      JSON.stringify(meta || {}),
      nowIso()
    ]
  );

  return res.status(201).json({
    message: '成绩已保存。',
    saved: {
      gameKey,
      gameName: GAME_MAP[gameKey],
      score: safeScore,
      durationSeconds: safeDuration,
      result
    }
  });
});

app.get('/api/admin/overview', requireAdminApi, (req, res) => {
  const userCount = queryOne('SELECT COUNT(*) AS count FROM users') || { count: 0 };
  const adminCount = queryOne("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'") || { count: 0 };
  const scoreCount = queryOne('SELECT COUNT(*) AS count FROM scores') || { count: 0 };
  const todayLogins = queryOne(
    "SELECT COUNT(*) AS count FROM login_logs WHERE success = 1 AND date(created_at) = date('now', 'localtime')"
  ) || { count: 0 };

  return res.json({
    summary: {
      userCount: Number(userCount.count || 0),
      adminCount: Number(adminCount.count || 0),
      scoreCount: Number(scoreCount.count || 0),
      todayLogins: Number(todayLogins.count || 0)
    }
  });
});

app.get('/api/admin/users', requireAdminApi, (req, res) => {
  const users = queryAll(
    `SELECT
       u.id,
       u.username,
       u.role,
       u.created_at AS createdAt,
       u.last_login_at AS lastLoginAt,
       COUNT(s.id) AS playCount,
       COALESCE(MAX(s.score), 0) AS bestScore
     FROM users u
     LEFT JOIN scores s ON s.user_id = u.id
     GROUP BY u.id, u.username, u.role, u.created_at, u.last_login_at
     ORDER BY datetime(u.created_at) ASC, u.id ASC`
  ).map((row) => ({
    id: Number(row.id),
    username: String(row.username),
    role: String(row.role),
    createdAt: String(row.createdAt),
    lastLoginAt: row.lastLoginAt ? String(row.lastLoginAt) : null,
    playCount: Number(row.playCount || 0),
    bestScore: Number(row.bestScore || 0)
  }));

  return res.json({ users, currentUserId: Number(req.session.user.id) });
});

app.patch('/api/admin/users/:id/role', requireAdminApi, (req, res) => {
  const userId = Number(req.params.id);
  const role = String(req.body.role || '').trim();

  if (!['admin', 'user'].includes(role)) {
    return res.status(400).json({ message: '角色只能是 admin 或 user。' });
  }

  const targetUser = queryOne('SELECT * FROM users WHERE id = ?', [userId]);
  if (!targetUser) {
    return res.status(404).json({ message: '用户不存在。' });
  }

  run('UPDATE users SET role = ? WHERE id = ?', [role, userId]);
  if (Number(req.session.user.id) === userId) {
    req.session.user.role = role;
  }

  return res.json({ message: `已将 ${targetUser.username} 的角色更新为 ${role}。` });
});

app.delete('/api/admin/users/:id', requireAdminApi, (req, res) => {
  const userId = Number(req.params.id);
  if (Number(req.session.user.id) === userId) {
    return res.status(400).json({ message: '不能删除当前登录的管理员账号。' });
  }

  const targetUser = queryOne('SELECT * FROM users WHERE id = ?', [userId]);
  if (!targetUser) {
    return res.status(404).json({ message: '用户不存在。' });
  }

  run('DELETE FROM scores WHERE user_id = ?', [userId]);
  run('DELETE FROM login_logs WHERE user_id = ?', [userId]);
  run('DELETE FROM users WHERE id = ?', [userId]);

  return res.json({ message: `已删除用户 ${targetUser.username}。` });
});

app.get('/api/admin/scores', requireAdminApi, (req, res) => {
  const gameKey = String(req.query.gameKey || '').trim();
  let sql = `
    SELECT s.id, s.game_key AS gameKey, s.game_name AS gameName, s.score, s.result,
           s.duration_seconds AS durationSeconds, s.created_at AS createdAt,
           u.username
    FROM scores s
    JOIN users u ON u.id = s.user_id
  `;
  const params = [];

  if (gameKey) {
    sql += ' WHERE s.game_key = ? ';
    params.push(gameKey);
  }

  sql += ' ORDER BY datetime(s.created_at) DESC, s.id DESC LIMIT 40';

  const rows = queryAll(sql, params).map((row) => ({
    id: Number(row.id),
    username: String(row.username),
    gameKey: String(row.gameKey),
    gameName: String(row.gameName),
    score: Number(row.score),
    result: String(row.result),
    durationSeconds: row.durationSeconds == null ? null : Number(row.durationSeconds),
    createdAt: String(row.createdAt)
  }));

  return res.json({ rows, gameMap: GAME_MAP });
});

app.delete('/api/admin/scores/:id', requireAdminApi, (req, res) => {
  const scoreId = Number(req.params.id);
  const score = queryOne('SELECT * FROM scores WHERE id = ?', [scoreId]);
  if (!score) {
    return res.status(404).json({ message: '成绩记录不存在。' });
  }
  run('DELETE FROM scores WHERE id = ?', [scoreId]);
  return res.json({ message: '成绩记录已删除。' });
});

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  Object.values(interfaces).forEach((items) => {
    (items || []).forEach((item) => {
      if (!item || item.internal) return;
      if (item.family === 'IPv4') {
        addresses.push(item.address);
      }
    });
  });

  return Array.from(new Set(addresses));
}

function startListening(startPort) {
  const host = process.env.HOST || '0.0.0.0';

  const tryPort = (port) => {
    const server = app.listen(port, host, () => {
      console.log(`服务器已启动：http://localhost:${port}`);
      console.log(`监听地址：http://${host}:${port}`);
      const lanAddresses = getLanAddresses();
      if (lanAddresses.length) {
        console.log('局域网访问地址：');
        lanAddresses.forEach((address) => {
          console.log(`  http://${address}:${port}`);
        });
      } else {
        console.log('未检测到可用的局域网 IPv4 地址，请确认电脑已连接 Wi-Fi 或网线。');
      }
      console.log(`默认管理员账号：admin / 123456`);
    });

    server.on('error', (error) => {
      if (error && error.code === 'EADDRINUSE' && port < startPort + 20) {
        console.log(`端口 ${port} 已被占用，自动尝试 ${port + 1}...`);
        tryPort(port + 1);
        return;
      }
      throw error;
    });
  };

  tryPort(startPort);
}


app.use('/api', (req, res) => {
  res.status(404).json({ message: `接口不存在：${req.originalUrl}` });
});

app.use((err, req, res, next) => {
  console.error('服务器异常：', err);

  if (res.headersSent) {
    return next(err);
  }

  if (req.originalUrl && req.originalUrl.startsWith('/api/')) {
    return res.status(500).json({
      message: err && err.message ? err.message : '服务器内部错误。'
    });
  }

  return res.status(500).send('服务器内部错误。');
});

(async function bootstrap() {
  await initDatabase();
  startListening(START_PORT);
})();
