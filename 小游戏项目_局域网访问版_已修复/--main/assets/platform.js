window.GamePlatform = (() => {
  const GAME_NAMES = {
    snake: '贪吃蛇大作战',
    minesweeper: '扫雷',
    fly: '飞机大战',
    maze: '迷宫小游戏'
  };

  async function fetchJSON(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers
    });

    const contentType = response.headers.get('content-type') || '';
    let data = null;

    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      const text = await response.text();
      const message = `接口 ${url} 未返回 JSON，请确认你是通过 Node 服务地址访问页面。响应片段：${text.slice(0, 120)}`;
      throw new Error(message);
    }

    if (!response.ok) {
      const message = data && data.message ? data.message : '请求失败';
      throw new Error(message);
    }

    return data;
  }

  async function getCurrentUser() {
    return fetchJSON('/api/me');
  }

  async function requireUser() {
    try {
      const data = await getCurrentUser();
      return data.user;
    } catch (error) {
      window.location.href = '/';
      throw error;
    }
  }

  async function logout() {
    await fetchJSON('/api/logout', { method: 'POST' });
    window.location.href = '/';
  }

  function formatDateTime(value) {
    if (!value) return '--';
    return new Date(value).toLocaleString();
  }

  function formatDuration(seconds) {
    if (seconds == null || !Number.isFinite(Number(seconds))) return '--';
    return `${Number(seconds).toFixed(1)}s`;
  }

  async function submitScore({ gameKey, score, durationSeconds = null, result = 'completed', meta = {} }) {
    return fetchJSON('/api/scores', {
      method: 'POST',
      body: JSON.stringify({ gameKey, score, durationSeconds, result, meta })
    });
  }

  async function injectHeader(config = {}) {
    const user = await requireUser();
    const current = document.createElement('div');
    current.className = 'platform-topbar';
    current.innerHTML = `
      <div class="platform-left">
        <a href="/game.html" class="platform-link">返回大厅</a>
        <a href="/profile.html" class="platform-link">用户中心</a>
        <a href="/leaderboard.html" class="platform-link">排行榜</a>
        ${user.role === 'admin' ? '<a href="/admin.html" class="platform-link">管理员后台</a>' : ''}
      </div>
      <div class="platform-right">
        <span class="platform-user">当前玩家：${user.username}（${user.role}）</span>
        <button class="platform-logout" id="platformLogoutBtn">退出登录</button>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      .platform-topbar {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        z-index: 999;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        background: rgba(15, 23, 42, 0.92);
        color: #fff;
        box-shadow: 0 8px 24px rgba(0,0,0,0.25);
        backdrop-filter: blur(8px);
        flex-wrap: wrap;
      }
      .platform-left, .platform-right {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .platform-link, .platform-logout {
        text-decoration: none;
        border: 1px solid rgba(255,255,255,0.18);
        background: rgba(255,255,255,0.08);
        color: #fff;
        border-radius: 10px;
        padding: 8px 12px;
        font-size: 13px;
        cursor: pointer;
      }
      .platform-user {
        font-size: 13px;
        color: #cbd5e1;
      }
    `;

    document.head.appendChild(style);
    document.body.prepend(current);
    document.body.style.paddingTop = (config.paddingTop || 82) + 'px';
    document.getElementById('platformLogoutBtn').addEventListener('click', logout);
    return user;
  }

  return {
    GAME_NAMES,
    fetchJSON,
    getCurrentUser,
    requireUser,
    logout,
    formatDateTime,
    formatDuration,
    submitScore,
    injectHeader
  };
})();
