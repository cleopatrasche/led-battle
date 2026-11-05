/* =====================================================================
 *  빛을 쏘다 : LED 컬러 슈팅 배틀 - 예약·리더보드 앱
 * ---------------------------------------------------------------------
 *  설정은 config.js 에서 합니다. 이 파일은 보통 고칠 필요가 없습니다.
 *
 *   1. 설정 읽기 · 회차 계산 · 시간
 *   2. 입력 확인 규칙과 안내 문구 (서버 schema.sql 과 같은 문구)
 *   3. 데모 모드 : 서버 없이 '이 기기' 에만 저장하는 연습용 가짜 서버
 *   4. 서버 호출 (Supabase) 과 오류 안내
 *   5. 화면 공통 : 모달 · 토스트 · 탭 이동
 *   6. 예약 화면        7. 리더보드        8. 체험 안내
 *   9. 관리자 화면      10. 시작
 * ===================================================================== */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : globalThis;

  var DEMO_ADMIN_PASSWORD = 'demo1234';   // 데모 모드 전용 관리자 비밀번호
  var DEMO_STORAGE_KEY = 'led-battle-demo-v1';
  var ADMIN_SESSION_KEY = 'led-battle-admin';
  var SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
  var SEAT_COLORS = ['red', 'yellow', 'green', 'blue'];   // 자리 색 = 게임 버튼 색
  var PIN_LOCK_LIMIT = 10;                                 // 비밀번호 10번 틀리면 잠김
  var GRACE_MINUTES = 5;                                   // 시작 후 5분까지는 예약 가능

  /* ===================================================================
   * 1. 설정 읽기 · 회차 계산 · 시간
   * =================================================================== */
  var DEFAULTS = {
    SUPABASE_URL: '', SUPABASE_KEY: '',
    EVENT_NAME: '', BOOTH_TITLE: '빛을 쏘다 : LED 컬러 슈팅 배틀', DATE_LABEL: '',
    PLACE: '', BOOTH_NO: '', NOTICES: [],
    EVENT_DATE: '2026-11-07', START: '10:00', END: '16:00',
    LUNCH_START: '12:00', LUNCH_END: '13:00', SLOT_MINUTES: 30, CAPACITY: 4,
    CLOSE_PAST_SLOTS: true, MASK_NAMES: false, POLL_SECONDS: 10
  };

  function toInt(v, def, min, max) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) n = def;
    if (n < min) n = min;
    if (n > max) n = max;
    return n;
  }

  function normalizeConfig(raw) {
    var c = {}, k;
    for (k in DEFAULTS) c[k] = DEFAULTS[k];
    if (raw) for (k in raw) if (raw[k] !== undefined && raw[k] !== null) c[k] = raw[k];
    // 흔한 실수 보정 : 끝의 / 나 /rest/v1 을 붙여 넣은 경우
    c.SUPABASE_URL = String(c.SUPABASE_URL || '').trim()
      .replace(/\/+$/, '').replace(/\/rest\/v1$/i, '').replace(/\/+$/, '');
    c.SUPABASE_KEY = String(c.SUPABASE_KEY || '').trim();
    c.SLOT_MINUTES = toInt(c.SLOT_MINUTES, 30, 5, 240);
    c.CAPACITY = toInt(c.CAPACITY, 4, 1, 50);
    c.POLL_SECONDS = toInt(c.POLL_SECONDS, 10, 3, 600);
    c.CLOSE_PAST_SLOTS = c.CLOSE_PAST_SLOTS !== false && c.CLOSE_PAST_SLOTS !== 'false';
    c.MASK_NAMES = c.MASK_NAMES === true || c.MASK_NAMES === 'true';
    c.NOTICES = Array.isArray(c.NOTICES) ? c.NOTICES : [];
    c.LUNCH_START = String(c.LUNCH_START || '').trim();
    c.LUNCH_END = String(c.LUNCH_END || '').trim();
    return c;
  }

  function toMin(hhmm) {
    var m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(hhmm == null ? '' : hhmm));
    if (!m) return null;
    var h = +m[1], mm = +m[2];
    if (h > 24 || mm > 59) return null;
    return h * 60 + mm;
  }

  function fromMin(t) {
    var h = Math.floor(t / 60), m = t % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  /* START~END 를 SLOT_MINUTES 간격으로 나누고, 점심시간과 겹치는 회차는 뺀다 */
  function computeSlots(c) {
    var s = toMin(c.START), e = toMin(c.END), step = c.SLOT_MINUTES;
    var ls = c.LUNCH_START ? toMin(c.LUNCH_START) : null;
    var le = c.LUNCH_END ? toMin(c.LUNCH_END) : null;
    var out = [];
    if (s == null || e == null || !(step > 0)) return out;
    for (var t = s; t + step <= e && out.length < 100; t += step) {
      if (ls != null && le != null && le > ls && t < le && t + step > ls) continue;
      out.push(fromMin(t));
    }
    return out;
  }

  function slotEnd(slot, c) { return fromMin(toMin(slot) + c.SLOT_MINUTES); }

  /* 한국 시간(KST) 기준 '지금'. 주소에 ?now=2026-11-07T10:33 을 붙이면 그 시각으로 미리보기 */
  function kstNow(override) {
    if (override) return override;
    var d = new Date(Date.now() + 9 * 3600000);
    return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }

  function parseNowOverride(search) {
    var m = /[?&]now=(\d{4}-\d{2}-\d{2})T(\d{1,2}):(\d{2})/.exec(search || '');
    return m ? { date: m[1], min: +m[2] * 60 + +m[3] } : null;
  }

  /* 행사 당일에만 : 시작 + 5분이 지난 회차는 닫힘 */
  function isPastSlot(slot, now, c) {
    if (!c.CLOSE_PAST_SLOTS || now.date !== c.EVENT_DATE) return false;
    return now.min >= toMin(slot) + GRACE_MINUTES;
  }

  /* ===================================================================
   * 2. 입력 확인 규칙과 안내 문구 (schema.sql 과 똑같이 맞춰 둠)
   * =================================================================== */
  var MSG = {
    slot: '시간 형식이 올바르지 않아요.',
    nameLength: '이름은 2~20자로 입력해 주세요.',
    nameLetters: '이름을 바르게 입력해 주세요. 숫자나 기호만으로는 예약할 수 없어요.',
    pin: '비밀번호는 숫자 4자리로 입력해 주세요.',
    full: function (slot) { return slot + ' 회차는 방금 마감되었어요. 다른 시간을 골라 주세요.'; },
    dupName: function (name, suggestion) {
      return '「' + name + '」 이름으로 이미 예약이 있어요. 동명이인이면 「' + suggestion +
        '」처럼 이름 뒤에 숫자를 붙여 주세요. 본인이 이미 예약했다면 새로 하지 말고 내 이름을 눌러 수정하세요.';
    },
    notFound: '예약을 찾을 수 없어요. 이미 취소되었을 수 있어요.',
    walkin: '현장에서 등록한 자리예요. 수정·취소는 부스 직원에게 말해 주세요.',
    locked: '비밀번호를 10번 틀려 예약이 잠겼어요. 부스 직원에게 문의하세요.',
    wrongPin: function (n) { return '비밀번호가 맞지 않아요. (남은 기회 ' + n + '번)'; },
    adminAuth: '관리자 비밀번호가 맞지 않아요.',
    score: '점수는 0 ~ 999,999 사이 숫자로 입력하세요.',
    confirmAll: "확인 문구가 달라요. '전체삭제' 네 글자를 그대로 입력하세요."
  };

  function RaiseError(message, details) {
    this.message = message;
    this.details = details || 'invalid';
    this.isRaise = true;
  }

  function raiseErr(message, details) { return new RaiseError(message, details); }

  function cleanName(s) {
    var v = String(s == null ? '' : s);
    if (v.normalize) v = v.normalize('NFC');
    return v.replace(/\s+/g, ' ').trim();
  }

  function nameKey(s) { return String(s == null ? '' : s).replace(/\s/g, '').toLowerCase(); }

  function charLen(s) { return Array.from(String(s)).length; }

  function validSlot(s) {
    if (s == null || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(s)) throw raiseErr(MSG.slot, 'invalid');
    return s;
  }

  function validName(n) {
    var v = cleanName(n), len = charLen(v);
    if (len < 2 || len > 20) throw raiseErr(MSG.nameLength, 'invalid');
    if (!/[A-Za-z]|[^ -~]/.test(v)) throw raiseErr(MSG.nameLetters, 'invalid');
    return v;
  }

  function validPin(p) {
    if (p == null || !/^[0-9]{4}$/.test(p)) throw raiseErr(MSG.pin, 'invalid');
  }

  /* 공개 화면에서 이름 가리기 : 김민준 → 김*준, 이준 → 이* */
  function maskName(name) {
    var a = Array.from(String(name == null ? '' : name));
    if (a.length <= 1) return a.join('');
    if (a.length === 2) return a[0] + '*';
    return a[0] + a.slice(1, -1).map(function (ch) { return ch === ' ' ? ' ' : '*'; }).join('') + a[a.length - 1];
  }

  function fmtScore(n) {
    return Number(n).toLocaleString('ko-KR');
  }

  /* ===================================================================
   * 3. 데모 모드 : schema.sql 의 함수들과 똑같이 동작하는 가짜 서버
   *    (자료는 이 브라우저의 localStorage 에만 저장됩니다)
   * =================================================================== */
  function memoryStorage() {
    var v = null;
    return {
      load: function () { return v ? JSON.parse(v) : null; },
      save: function (x) { v = JSON.stringify(x); }
    };
  }

  function localStore(key) {
    var mem = memoryStorage();
    return {
      load: function () {
        try { var s = root.localStorage.getItem(key); return s ? JSON.parse(s) : null; }
        catch (e) { return mem.load(); }
      },
      save: function (x) {
        try { root.localStorage.setItem(key, JSON.stringify(x)); }
        catch (e) { mem.save(x); }
      }
    };
  }

  function makeUuid() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (ch) {
      var r = Math.random() * 16 | 0;
      return (ch === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }

  function createMockBackend(opts) {
    var store = opts.storage;
    var capacity = opts.capacity;
    var adminPw = opts.adminPassword;
    var latency = opts.latency || 0;

    function load() {
      var d = store.load();
      return d && Array.isArray(d.rows) ? d : { rows: [], seq: 0 };
    }

    /* 함수 하나 실행 = 트랜잭션 하나 : 오류(raise)면 바뀐 내용을 저장하지 않는다 */
    function exec(fn, p) {
      var db = load();

      function tick() { db.seq += 1; return db.seq; }
      function iso() { return new Date().toISOString(); }
      function find(id) {
        for (var i = 0; i < db.rows.length; i++) if (db.rows[i].id === id) return db.rows[i];
        return null;
      }
      function nameTaken(name, exceptId) {
        var k = nameKey(name);
        return db.rows.some(function (r) { return nameKey(r.name) === k && r.id !== exceptId; });
      }
      function dupMessage(name) {
        for (var n = 2; n <= 99; n++) if (!nameTaken(name + n, null)) return MSG.dupName(name, name + n);
        return MSG.dupName(name, name + '2');
      }
      function assertNameFree(name, exceptId) {
        if (nameTaken(name, exceptId)) throw raiseErr(dupMessage(name), 'dup_name');
      }
      function countSlot(slot, exceptId) {
        return db.rows.filter(function (r) { return r.slot === slot && r.id !== exceptId; }).length;
      }
      function sorted() {
        return db.rows.slice().sort(function (a, b) {
          return a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : a.c - b.c;
        });
      }
      function touch(r) { r.u = tick(); r.updated_at = iso(); }
      function checkPw(pw) { return String(pw == null ? '' : pw).trim() === adminPw; }
      function guard(pw) { if (!checkPw(pw)) throw raiseErr(MSG.adminAuth, 'admin_auth'); }
      function mustFind(id) { var r = find(id); if (!r) throw raiseErr(MSG.notFound, 'not_found'); return r; }
      function pinCheck(id, pin) {
        var r = mustFind(id);
        if (r.pin == null) throw raiseErr(MSG.walkin, 'walkin');
        validPin(pin);
        if (r.pin_fail >= PIN_LOCK_LIMIT) return { ok: false, code: 'locked', message: MSG.locked };
        if (r.pin === pin) { r.pin_fail = 0; return { ok: true }; }
        r.pin_fail += 1;
        if (r.pin_fail >= PIN_LOCK_LIMIT) return { ok: false, code: 'locked', message: MSG.locked };
        var left = PIN_LOCK_LIMIT - r.pin_fail;
        return { ok: false, code: 'wrong_pin', remaining: left, message: MSG.wrongPin(left) };
      }

      var F = {
        list_reservations: function () {
          return sorted().map(function (r) {
            return { id: r.id, slot: r.slot, name: r.name, has_pin: r.pin != null };
          });
        },
        leaderboard: function () {
          var s = db.rows.filter(function (r) { return r.score != null; });
          s.sort(function (a, b) {
            return (b.score - a.score) || (a.u - b.u) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
          });
          return s.map(function (r) {
            var higher = s.filter(function (x) { return x.score > r.score; }).length;
            return { rank: higher + 1, name: r.name, score: r.score, slot: r.slot };
          });
        },
        book: function () {
          var slot = validSlot(p.p_slot);
          var name = validName(p.p_name);
          validPin(p.p_pin);
          assertNameFree(name, null);
          if (countSlot(slot, null) >= capacity) throw raiseErr(MSG.full(slot), 'full');
          var t = tick(), now = iso();
          var row = { id: makeUuid(), slot: slot, name: name, pin: p.p_pin, pin_fail: 0, score: null,
                      c: t, u: t, created_at: now, updated_at: now };
          db.rows.push(row);
          return row.id;
        },
        verify_pin: function () { return pinCheck(p.p_id, p.p_pin); },
        update_booking: function () {
          var chk = pinCheck(p.p_id, p.p_pin);
          if (!chk.ok) return chk;
          var r = find(p.p_id);
          var slot = p.p_slot == null ? r.slot : validSlot(p.p_slot);
          var name = p.p_name == null ? r.name : validName(p.p_name);
          if (name !== r.name) assertNameFree(name, r.id);
          if (slot !== r.slot && countSlot(slot, r.id) >= capacity) throw raiseErr(MSG.full(slot), 'full');
          if (name !== r.name || slot !== r.slot) { r.name = name; r.slot = slot; touch(r); }
          return { ok: true, slot: slot, name: name };
        },
        cancel_booking: function () {
          var chk = pinCheck(p.p_id, p.p_pin);
          if (!chk.ok) return chk;
          db.rows = db.rows.filter(function (r) { return r.id !== p.p_id; });
          return { ok: true };
        },
        admin_check: function () { return checkPw(p.p_pw); },
        admin_list: function () {
          guard(p.p_pw);
          return sorted().map(function (r) {
            return { id: r.id, slot: r.slot, name: r.name, has_pin: r.pin != null, score: r.score,
                     pin_fail: r.pin_fail, locked: r.pin_fail >= PIN_LOCK_LIMIT,
                     created_at: r.created_at, updated_at: r.updated_at };
          });
        },
        admin_set_score: function () {
          guard(p.p_pw);
          var s = p.p_score == null ? null : p.p_score;
          if (s !== null && (typeof s !== 'number' || Math.floor(s) !== s || s < 0 || s > 999999)) {
            throw raiseErr(MSG.score, 'invalid');
          }
          var r = mustFind(p.p_id);
          if (r.score !== s) touch(r);
          r.score = s;
          r.pin_fail = 0;
          return true;
        },
        admin_add: function () {
          guard(p.p_pw);
          var slot = validSlot(p.p_slot);
          var name = validName(p.p_name);
          assertNameFree(name, null);
          var t = tick(), now = iso();
          var row = { id: makeUuid(), slot: slot, name: name, pin: null, pin_fail: 0, score: null,
                      c: t, u: t, created_at: now, updated_at: now };
          db.rows.push(row);
          return row.id;
        },
        admin_update: function () {
          guard(p.p_pw);
          var r = mustFind(p.p_id);
          var slot = p.p_slot == null ? r.slot : validSlot(p.p_slot);
          var name = p.p_name == null ? r.name : validName(p.p_name);
          if (name !== r.name) assertNameFree(name, r.id);
          var changed = slot !== r.slot || name !== r.name;
          r.slot = slot; r.name = name; r.pin_fail = 0;
          if (changed) touch(r);
          return true;
        },
        admin_replace: function () {
          guard(p.p_pw);
          var r = mustFind(p.p_id);
          var name = validName(p.p_name);
          if (name !== r.name) assertNameFree(name, r.id);
          r.name = name; r.pin = null; r.pin_fail = 0; r.score = null;
          touch(r);
          return true;
        },
        admin_delete: function () {
          guard(p.p_pw);
          var before = db.rows.length;
          db.rows = db.rows.filter(function (r) { return r.id !== p.p_id; });
          return db.rows.length < before;
        },
        admin_delete_all: function () {
          guard(p.p_pw);
          if (String(p.p_confirm == null ? '' : p.p_confirm).trim() !== '전체삭제') {
            throw raiseErr(MSG.confirmAll, 'invalid');
          }
          var n = db.rows.length;
          db.rows = [];
          return n;
        }
      };

      if (!Object.prototype.hasOwnProperty.call(F, fn)) {
        return { data: null, status: 404,
                 error: { code: 'PGRST202', message: 'Could not find the function public.' + fn, details: null, hint: null } };
      }
      try {
        var data = F[fn]();
        store.save(db);                       // 정상 종료 → 저장(커밋)
        return { data: data, error: null, status: 200 };
      } catch (e) {
        if (e && e.isRaise) {                 // 오류 → 저장하지 않음(롤백)
          return { data: null, status: 400, error: { code: 'P0001', message: e.message, details: e.details, hint: null } };
        }
        return { data: null, status: 500, error: { code: 'XX000', message: String((e && e.message) || e), details: null, hint: null } };
      }
    }

    return {
      rpc: function (fn, params) {
        return new Promise(function (resolve) {
          setTimeout(function () { resolve(exec(fn, params || {})); }, latency);
        });
      }
    };
  }

  /* ===================================================================
   * 4. 서버 호출 (Supabase) 과 오류 안내
   * =================================================================== */
  function AppError(message, code, extra) {
    this.message = message;
    this.code = code || 'error';
    this.extra = extra || null;
  }
  AppError.prototype = Object.create(Error.prototype);
  AppError.prototype.constructor = AppError;
  AppError.prototype.name = 'AppError';

  var ERR_TEXT = {
    network: '인터넷 연결이 불안정해요. 잠시 후 다시 시도해 주세요.',
    setup: '서버에 예약 기능이 아직 설치되지 않았어요. (운영자: Supabase 에서 schema.sql 을 실행했는지 확인)',
    key: 'Supabase 키가 올바르지 않아요. (운영자: config.js 의 SUPABASE_URL·SUPABASE_KEY 확인)',
    server: '서버에서 문제가 생겼어요. 잠시 후 다시 시도해 주세요.'
  };

  var SECRET_KEY_MSG = 'config.js 에 비밀(secret / service_role) 키가 들어 있어요! 이 파일은 누구나 볼 수 있으니 ' +
    'Supabase 에서 그 키를 바로 폐기(교체)하고, Publishable key(sb_publishable_…) 또는 anon 키를 넣으세요.';

  function toAppError(err, status) {
    var msg = String((err && err.message) || '');
    var code = String((err && err.code) || '');
    if (code === 'P0001') return new AppError(msg, (err && err.details) || 'error');
    if (code === 'PGRST202' || code === '42883' || code === '42501' || status === 404) {
      return new AppError(ERR_TEXT.setup, 'setup');
    }
    if (status === 401 || status === 403 || /api key|apikey|jwt|unauthori[sz]ed/i.test(msg)) {
      return new AppError(ERR_TEXT.key, 'key');
    }
    if (!status || /fetch|network|load failed|abort|timeout|timed out/i.test(msg)) {
      return new AppError(ERR_TEXT.network, 'network');
    }
    return new AppError(ERR_TEXT.server + (msg ? ' (' + msg + ')' : ''), 'server');
  }

  /* 서버 함수 호출 : 성공하면 결과, 실패하면 AppError(화면에 보여 줄 문구) */
  function makeCaller(backend, timeoutMs) {
    return function call(fn, params) {
      return new Promise(function (resolve, reject) {
        var done = false;
        var timer = setTimeout(function () {
          if (done) return;
          done = true;
          reject(new AppError(ERR_TEXT.network, 'network'));
        }, timeoutMs || 15000);
        Promise.resolve()
          .then(function () { return backend.rpc(fn, params || {}); })
          .then(function (res) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (!res || res.error) return reject(toAppError(res && res.error, res && res.status));
            var d = res.data;
            if (d && typeof d === 'object' && !Array.isArray(d) && d.ok === false) {
              return reject(new AppError(d.message, d.code, d));
            }
            resolve(d);
          }, function (e) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            reject(toAppError({ message: String((e && e.message) || e) }, 0));
          });
      });
    };
  }

  function createSupabaseBackend(url, key) {
    var client = root.supabase.createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    return { rpc: function (fn, params) { return client.rpc(fn, params); } };
  }

  function keyProblem(key) {
    if (!key) return 'config.js 의 SUPABASE_KEY 가 비어 있어요. Publishable key 를 붙여 넣으세요.';
    if (/^sb_secret_/i.test(key)) return SECRET_KEY_MSG;
    var parts = key.split('.');
    if (parts.length === 3) {
      try {
        var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        var payload = JSON.parse(root.atob(b64));
        if (payload && payload.role === 'service_role') return SECRET_KEY_MSG;
      } catch (e) { /* 형식을 몰라도 일단 진행 */ }
    }
    return null;
  }

  function urlProblem(url) {
    if (!/^https?:\/\/[^\s/]+/i.test(url)) {
      return 'config.js 의 SUPABASE_URL 이 이상해요. https://xxxx.supabase.co 모양으로 넣으세요.';
    }
    return null;
  }

  function loadSupabaseLib(timeoutMs) {
    if (root.supabase && root.supabase.createClient) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      var timer = setTimeout(function () { reject(new Error('timeout')); }, timeoutMs);
      s.src = SUPABASE_CDN;
      s.async = true;
      s.onload = function () {
        clearTimeout(timer);
        if (root.supabase && root.supabase.createClient) resolve();
        else reject(new Error('no global'));
      };
      s.onerror = function () { clearTimeout(timer); reject(new Error('load error')); };
      document.head.appendChild(s);
    });
  }

  /* Node(자동 테스트)에서는 화면 없이 위 기능만 내보낸다 */
  if (typeof module === 'object' && module.exports) {
    module.exports = {
      normalizeConfig: normalizeConfig, computeSlots: computeSlots, toMin: toMin, fromMin: fromMin,
      isPastSlot: isPastSlot, parseNowOverride: parseNowOverride, maskName: maskName,
      cleanName: cleanName, nameKey: nameKey, validName: validName, validPin: validPin,
      validSlot: validSlot, keyProblem: keyProblem, toAppError: toAppError, makeCaller: makeCaller,
      createMockBackend: createMockBackend, memoryStorage: memoryStorage, MSG: MSG,
      DEMO_ADMIN_PASSWORD: DEMO_ADMIN_PASSWORD
    };
    return;
  }

  /* ===================================================================
   * 5. 화면 공통
   * =================================================================== */
  var S = {
    cfg: null, slots: [], call: null, mode: 'loading', nowOverride: null,
    tab: null,
    list: null, listSig: '', listErr: null, listAt: null,
    board: null, boardSig: '', boardErr: null, boardAt: null,
    admin: { pw: null, rows: null, sig: '', err: null }
  };

  function $(sel, el) { return (el || document).querySelector(sel); }
  function $all(sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function publicName(name) { return S.cfg.MASK_NAMES ? maskName(name) : name; }

  function clock(d) {
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function sessionGet(key) { try { return root.sessionStorage.getItem(key); } catch (e) { return null; } }
  function sessionSet(key, v) { try { root.sessionStorage.setItem(key, v); } catch (e) { /* 무시 */ } }
  function sessionDel(key) { try { root.sessionStorage.removeItem(key); } catch (e) { /* 무시 */ } }

  /* --- 모달 (팝업 차단과 무관한 화면 안 창) --- */
  var modals = [];
  var modalSeq = 0;

  function openModal(opts) {
    var id = 'm' + (++modalSeq);
    var lastFocus = document.activeElement;
    var wrap = document.createElement('div');
    wrap.className = 'modal' + (opts.tone ? ' modal--' + opts.tone : '');
    wrap.innerHTML =
      '<div class="modal-backdrop" data-dismiss></div>' +
      '<div class="modal-box" role="dialog" aria-modal="true" tabindex="-1" aria-labelledby="' + id + '-t">' +
        '<div class="modal-head">' +
          '<h2 class="modal-title" id="' + id + '-t">' + esc(opts.title) + '</h2>' +
          '<button type="button" class="modal-x" data-dismiss aria-label="닫기">✕</button>' +
        '</div>' +
        '<div class="modal-body"></div>' +
      '</div>';
    $('#modalRoot').appendChild(wrap);
    document.body.classList.add('has-modal');
    var api = {
      el: wrap,
      body: $('.modal-body', wrap),
      closed: false,
      setTitle: function (t) { $('.modal-title', wrap).textContent = t; },
      setBody: function (html) { api.body.innerHTML = html; focusFirst(); },
      close: function () {
        if (api.closed) return;
        api.closed = true;
        wrap.remove();
        modals = modals.filter(function (m) { return m !== api; });
        if (!modals.length) document.body.classList.remove('has-modal');
        if (lastFocus && lastFocus.focus && document.contains(lastFocus)) {
          try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* 무시 */ }
        }
        if (opts.onClose) opts.onClose();
      }
    };
    /* 마우스·키보드 기기(노트북)는 첫 입력칸에 바로 커서를 두고,
       터치 기기(휴대폰·태블릿)는 키보드가 창을 가리지 않도록 창 자체에만 초점을 둔다 */
    function focusFirst() {
      var fine = root.matchMedia && root.matchMedia('(pointer: fine)').matches;
      var f = fine ? ($('input:not([type=hidden]):not([disabled]), select, textarea', api.body) ||
                      $('.btn.primary, button', api.body)) : null;
      try { (f || $('.modal-box', wrap)).focus({ preventScroll: true }); } catch (e) { /* 무시 */ }
    }
    wrap.addEventListener('click', function (e) {
      if (e.target.closest('[data-dismiss]')) api.close();
    });
    modals.push(api);
    api.body.innerHTML = opts.html || '';
    if (opts.onOpen) opts.onOpen(api);
    focusFirst();
    return api;
  }

  function topModal() { return modals[modals.length - 1] || null; }

  function setBusy(btn, busy, text) {
    if (!btn) return;
    if (busy) {
      if (btn.dataset.busy !== '1') { btn.dataset.label = btn.textContent; btn.dataset.busy = '1'; }
      btn.textContent = text || '처리 중…';
      btn.disabled = true;
    } else {
      if (btn.dataset.busy === '1') { btn.textContent = btn.dataset.label; btn.dataset.busy = ''; }
      btn.disabled = false;
    }
  }

  function formError(scope, msg) {
    var el = $('.form-error', scope);
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  var toastTimer = null;
  function toast(msg, tone) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (tone ? ' toast--' + tone : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 2800);
  }

  function setNet(ok) { $('#netBanner').hidden = ok; }

  /* 숫자만 남기는 입력칸 (비밀번호 4자리) */
  function digitsOnly(input, max) {
    input.addEventListener('input', function () {
      var v = input.value.replace(/\D/g, '').slice(0, max);
      if (v !== input.value) input.value = v;
    });
  }

  function pinField(name, label) {
    return '<label class="field"><span class="field-label">' + label + '</span>' +
      // maxlength 는 숫자만 거르기 전에 잘라 버리므로 쓰지 않음 (붙여넣기 '12-34' → 1234)
      '<span class="pin-wrap"><input class="pin" name="' + name + '" type="text" inputmode="numeric" ' +
      'pattern="[0-9]*" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="••••">' +
      '<button type="button" class="pin-eye" data-eye aria-label="숫자 보기">보기</button></span></label>';
  }

  function wirePins(scope) {
    $all('input.pin', scope).forEach(function (i) { digitsOnly(i, 4); });
    $all('[data-eye]', scope).forEach(function (b) {
      b.addEventListener('click', function () {
        var inp = b.parentNode.querySelector('input');
        var shown = inp.classList.toggle('is-shown');
        b.textContent = shown ? '숨김' : '보기';
        b.setAttribute('aria-label', shown ? '숫자 숨기기' : '숫자 보기');
      });
    });
  }

  /* --- 탭 이동 (#reserve / #board / #guide / #guide-xxx / #play / #admin) --- */
  function route() {
    var h = (location.hash || '').replace(/^#/, '');
    var tab = 'reserve', anchor = null;
    if (h === 'board') tab = 'board';
    else if (h === 'admin') tab = 'admin';
    else if (h === 'play') tab = 'play';
    else if (h === 'guide') { tab = 'guide'; anchor = 'top'; }
    else if (h.indexOf('guide-') === 0) { tab = 'guide'; anchor = h.slice(6); }
    var changed = S.tab !== tab;
    S.tab = tab;
    $all('.view').forEach(function (v) { v.hidden = v.getAttribute('data-view') !== tab; });
    $all('.tabs a').forEach(function (a) {
      var on = a.getAttribute('data-tab') === tab;
      a.classList.toggle('is-active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.body.setAttribute('data-tab', tab);
    if (tab !== 'board') exitTv();
    if (tab === 'guide') guideJump(anchor);
    else if (changed) root.scrollTo(0, 0);
    if (tab === 'admin') {
      if (!S.admin.pw) { if (!$('#adminLogin')) renderAdminLogin(); }
      else if (!$('#adminMain')) $('#adminRoot').innerHTML = '<p class="loading">불러오는 중…</p>';
    }
    refreshCurrent(true);
  }

  function refreshCurrent(force) {
    if (!S.call) return;
    if (S.tab === 'reserve') loadList(force);
    else if (S.tab === 'board') loadBoard(force);
    else if (S.tab === 'admin') loadAdmin(force);
  }

  /* 불러오기 도우미 : 이미 불러오는 중에 또 요청이 오면 끝난 뒤 한 번 더 불러온다
     (방금 저장한 내용이 이전 응답에 덮여 안 보이는 일을 막음) */
  function makeLoader(fetchFn, onOk, onErr) {
    var busy = false, again = false, againForce = false;
    function run(force) {
      if (!S.call) return Promise.resolve();
      if (busy) { again = true; againForce = againForce || !!force; return Promise.resolve(); }
      busy = true;
      return fetchFn().then(function (d) { onOk(d, force); }, function (e) { onErr(e); })
        .then(function () {
          busy = false;
          if (again) {
            var f = againForce;
            again = false;
            againForce = false;
            return run(f);
          }
        });
    }
    return run;
  }

  /* ===================================================================
   * 6. 예약 화면
   * =================================================================== */
  var loadList = makeLoader(function () {
    return S.call('list_reservations');
  }, function (rows, force) {
    S.list = rows || [];
    S.listErr = null;
    S.listAt = new Date();
    setNet(true);
    renderSlots(force);
  }, function (e) {
    S.listErr = e;
    if (e.code === 'network') setNet(false);
    renderSlots(true);
  });

  function groupBySlot(rows) {
    var g = {};
    (rows || []).forEach(function (r) { (g[r.slot] = g[r.slot] || []).push(r); });
    return g;
  }

  function slotInfo(slot, people, now) {
    var c = S.cfg;
    var past = isPastSlot(slot, now, c);
    var left = Math.max(0, c.CAPACITY - people.length);
    return { past: past, left: left, full: left === 0, open: !past && left > 0 };
  }

  function renderSlots(force) {
    var el = $('#slotList');
    var c = S.cfg;
    if (!S.list) {
      if (S.listErr) {
        el.innerHTML = '<li class="load-error"><p>' + esc(S.listErr.message) + '</p>' +
          '<button type="button" class="btn" data-act="retry">다시 시도</button></li>';
      }
      return;
    }
    var now = kstNow(S.nowOverride);
    var sig = JSON.stringify([S.list, now.date, now.min, S.cfg.MASK_NAMES]);
    if (!force && sig === S.listSig) { stampUpdated(); return; }
    S.listSig = sig;

    var bySlot = groupBySlot(S.list);
    var html = '';
    S.slots.forEach(function (slot, i) {
      if (i > 0) {
        var prevEnd = toMin(S.slots[i - 1]) + c.SLOT_MINUTES;
        if (toMin(slot) > prevEnd) {
          var gs = fromMin(prevEnd), ge = slot;
          var isLunch = c.LUNCH_START && toMin(c.LUNCH_START) < toMin(ge) && toMin(c.LUNCH_END) > prevEnd;
          html += '<li class="slot-gap"><span>' + (isLunch ? '점심시간' : '쉬는 시간') + ' ' +
            esc(gs) + ' ~ ' + esc(ge) + '</span></li>';
        }
      }
      var people = bySlot[slot] || [];
      var st = slotInfo(slot, people, now);
      var cls = st.past ? 'is-past' : st.full ? 'is-full' : 'is-open';
      var pill = st.past ? '지난 시간' : st.full ? '마감' : '남은 자리 ' + st.left + '/' + c.CAPACITY;
      var seats = '';
      var total = Math.max(c.CAPACITY, people.length);
      for (var k = 0; k < total; k++) {
        var color = SEAT_COLORS[k % SEAT_COLORS.length];
        var p = people[k];
        if (p) {
          var nlen = charLen(publicName(p.name));
          var lenCls = nlen >= 6 ? ' is-long is-xlong' : nlen >= 4 ? ' is-long' : '';
          seats += '<button type="button" class="seat seat--' + color + ' is-taken' + lenCls + (p.has_pin ? '' : ' is-walkin') + '"' +
            ' data-act="manage" data-id="' + esc(p.id) + '"' +
            ' aria-label="' + esc(slot + ' 회차 ' + publicName(p.name) + ', 수정·취소') + '">' +
            '<span class="seat-name">' + esc(publicName(p.name)) + '</span>' +
            (p.has_pin ? '' : '<span class="seat-tag">현장</span>') + '</button>';
        } else if (st.past) {
          seats += '<span class="seat seat--' + color + ' is-off" aria-hidden="true"></span>';
        } else {
          seats += '<button type="button" class="seat seat--' + color + ' is-empty" data-act="book"' +
            ' data-slot="' + esc(slot) + '" aria-label="' + esc(slot + ' 회차 빈 자리 예약하기') + '">' +
            '<span class="seat-plus" aria-hidden="true">+</span><span class="seat-name">예약</span></button>';
        }
      }
      html += '<li class="slot ' + cls + '" data-slot="' + esc(slot) + '">' +
        '<div class="slot-head">' +
          '<p class="slot-time"><span class="t-start">' + esc(slot) + '</span>' +
          '<span class="t-end">~ ' + esc(slotEnd(slot, c)) + '</span></p>' +
          '<p class="slot-pill">' + esc(pill) + '</p>' +
        '</div>' +
        '<div class="seats">' + seats + '</div>' +
      '</li>';
    });
    if (!S.slots.length) {
      html = '<li class="load-error"><p>회차가 없어요. config.js 의 START·END·SLOT_MINUTES 를 확인하세요.</p></li>';
    }
    el.innerHTML = html;
    stampUpdated();
  }

  function stampUpdated() {
    if (S.listAt) {
      $('#listUpdated').textContent = '마지막 갱신 ' + clock(S.listAt) + ' · ' + S.cfg.POLL_SECONDS + '초마다 자동으로 새로고침';
    }
  }

  function findRow(id) {
    var rows = S.list || [];
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
    return null;
  }

  function onSlotClick(e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    if (act === 'retry') { S.listErr = null; loadList(true); return; }
    if (!S.call) return;
    if (act === 'book') openBookModal(b.getAttribute('data-slot'));
    if (act === 'manage') {
      var row = findRow(b.getAttribute('data-id'));
      if (row) openManageModal(row);
    }
  }

  function openBookModal(slot) {
    var c = S.cfg;
    var html =
      '<form class="form" novalidate>' +
        '<p class="slot-tag"><b>' + esc(slot) + ' ~ ' + esc(slotEnd(slot, c)) + '</b> ' +
          esc(c.BOOTH_NO ? c.BOOTH_NO + ' 부스' : '') + '</p>' +
        '<label class="field"><span class="field-label">이름 (실명)</span>' +
          '<input name="fullname" type="text" maxlength="20" autocomplete="off" placeholder="예: 김민준" enterkeyhint="next"></label>' +
        '<div class="field-pair">' + pinField('pin', '비밀번호 (숫자 4자리)') + pinField('pin2', '비밀번호 확인') + '</div>' +
        '<p class="hint">수정하거나 취소할 때 이 숫자 4자리가 필요해요. 꼭 기억하세요!</p>' +
        '<label class="check"><input type="checkbox" name="agree">' +
          '<span>예약 시간에 오지 않으면 자리가 넘어갈 수 있다는 것을 확인했어요</span></label>' +
        '<p class="form-error" role="alert" hidden></p>' +
        '<div class="actions"><button type="button" class="btn" data-dismiss>닫기</button>' +
          '<button type="submit" class="btn primary">예약하기</button></div>' +
      '</form>';
    openModal({
      title: slot + ' 회차 예약',
      html: html,
      onOpen: function (m) {
        var form = $('form', m.body);
        wirePins(form);
        form.addEventListener('submit', function (ev) {
          ev.preventDefault();
          var name = cleanName(form.querySelector('[name=fullname]').value);
          var pin = form.querySelector('[name=pin]').value;
          var pin2 = form.querySelector('[name=pin2]').value;
          try {
            validName(name);
            validPin(pin);
          } catch (err) { formError(form, err.message); return; }
          if (pin !== pin2) { formError(form, '비밀번호 확인이 일치하지 않아요. 같은 숫자 4자리를 두 번 입력해 주세요.'); return; }
          if (!form.querySelector('[name=agree]').checked) {
            formError(form, '안내를 읽고 「예약 시간에 오지 않으면…」 칸에 체크해 주세요.');
            return;
          }
          formError(form, '');
          var btn = form.querySelector('[type=submit]');
          setBusy(btn, true, '예약하는 중…');
          S.call('book', { p_slot: slot, p_name: name, p_pin: pin }).then(function () {
            m.close();
            showDone('예약되었습니다', slot, name);
            loadList(true);
          }, function (err) {
            setBusy(btn, false);
            formError(form, err.message);
            if (err.code === 'full') loadList(true);
          });
        });
      }
    });
  }

  function showDone(title, slot, name) {
    var c = S.cfg;
    openModal({
      title: title,
      tone: 'ok',
      html:
        '<div class="done">' +
          '<p class="done-main">' + esc(slot) + ', ' + esc(c.BOOTH_NO) + ' 부스</p>' +
          '<p class="done-who">' + esc(name) + ' · ' + esc(slot) + ' ~ ' + esc(slotEnd(slot, c)) + '</p>' +
          '<p class="done-warn">정시에 오지 않으면 다른 분으로 바뀔 수 있어요.</p>' +
          '<p class="hint">수정·취소할 때 비밀번호 4자리가 필요해요. 이 화면을 캡처해 두면 편해요.</p>' +
          '<div class="actions"><button type="button" class="btn primary" data-dismiss>확인</button></div>' +
        '</div>'
    });
  }

  function openManageModal(row) {
    var who = publicName(row.name);
    if (!row.has_pin) {
      openModal({
        title: '본인 예약 수정·취소',
        html: '<p class="lead"><b>' + esc(who) + '</b> · ' + esc(row.slot) + ' 회차</p>' +
          '<p>' + esc(MSG.walkin) + '</p>' +
          '<div class="actions"><button type="button" class="btn primary" data-dismiss>확인</button></div>'
      });
      return;
    }
    var pinHtml =
      '<form class="form" novalidate>' +
        '<p class="lead"><b>' + esc(who) + '</b> · ' + esc(row.slot) + ' 회차</p>' +
        pinField('pin', '예약할 때 정한 비밀번호 4자리') +
        '<p class="form-error" role="alert" hidden></p>' +
        '<div class="actions"><button type="button" class="btn" data-dismiss>닫기</button>' +
          '<button type="submit" class="btn primary">확인</button></div>' +
      '</form>';
    openModal({
      title: '본인 예약 수정·취소',
      html: pinHtml,
      onOpen: function (m) {
        var form = $('form', m.body);
        wirePins(form);
        form.addEventListener('submit', function (ev) {
          ev.preventDefault();
          var input = form.querySelector('[name=pin]');
          var pin = input.value;
          try { validPin(pin); } catch (err) { formError(form, err.message); return; }
          var btn = form.querySelector('[type=submit]');
          setBusy(btn, true, '확인 중…');
          S.call('verify_pin', { p_id: row.id, p_pin: pin }).then(function () {
            showManageMenu(m, row, pin);
          }, function (err) {
            setBusy(btn, false);
            input.value = '';
            formError(form, err.message);
            if (err.code === 'not_found') { loadList(true); }
          });
        });
      }
    });
  }

  function movableSlots(currentSlot) {
    var now = kstNow(S.nowOverride);
    var bySlot = groupBySlot(S.list);
    return S.slots.filter(function (s) {
      if (s === currentSlot) return false;
      return slotInfo(s, bySlot[s] || [], now).open;
    }).map(function (s) {
      return { slot: s, left: slotInfo(s, bySlot[s] || [], now).left };
    });
  }

  function showManageMenu(m, row, pin) {
    var c = S.cfg;
    var opts = movableSlots(row.slot);
    var select = opts.length
      ? '<select name="slot" aria-label="바꿀 시간">' + opts.map(function (o) {
          return '<option value="' + esc(o.slot) + '">' + esc(o.slot) + ' (남은 자리 ' + o.left + ')</option>';
        }).join('') + '</select><button type="button" class="btn primary" data-do="move">시간 바꾸기</button>'
      : '<p class="muted">지금 옮길 수 있는 빈 시간이 없어요.</p>';
    m.setTitle('본인 예약 수정·취소');
    m.setBody(
      '<div class="manage">' +
        '<p class="lead"><b>' + esc(row.name) + '</b> · ' + esc(row.slot) + ' ~ ' + esc(slotEnd(row.slot, c)) + '</p>' +
        '<section class="opt"><h3>시간 변경</h3><div class="opt-row">' + select + '</div></section>' +
        '<section class="opt"><h3>이름 수정</h3><div class="opt-row">' +
          '<input name="newname" type="text" maxlength="20" autocomplete="off" aria-label="새 이름" value="' + esc(row.name) + '">' +
          '<button type="button" class="btn" data-do="rename">이름 저장</button></div></section>' +
        '<section class="opt opt--danger"><h3>예약 취소</h3>' +
          '<button type="button" class="btn danger" data-do="cancel">예약 취소하기</button></section>' +
        '<p class="form-error" role="alert" hidden></p>' +
      '</div>'
    );
    var box = $('.manage', m.body);
    function fail(btn, err) {
      setBusy(btn, false);
      formError(box, err.message);
      if (err.code === 'not_found') { m.close(); toast(err.message, 'warn'); loadList(true); }
      if (err.code === 'full') loadList(true);
    }
    box.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-do]');
      if (!b) return;
      var what = b.getAttribute('data-do');
      formError(box, '');
      if (what === 'move') {
        var to = $('select[name=slot]', box).value;
        setBusy(b, true, '바꾸는 중…');
        S.call('update_booking', { p_id: row.id, p_pin: pin, p_slot: to, p_name: null }).then(function (res) {
          m.close();
          showDone('예약이 변경되었습니다', (res && res.slot) || to, (res && res.name) || row.name);
          loadList(true);
        }, function (err) { fail(b, err); });
      } else if (what === 'rename') {
        var nn = cleanName($('input[name=newname]', box).value);
        try { validName(nn); } catch (err) { formError(box, err.message); return; }
        if (nn === row.name) { formError(box, '지금 이름과 같아요.'); return; }
        setBusy(b, true, '저장 중…');
        S.call('update_booking', { p_id: row.id, p_pin: pin, p_slot: null, p_name: nn }).then(function () {
          m.close();
          toast('이름을 「' + nn + '」(으)로 바꿨어요.', 'ok');
          loadList(true);
        }, function (err) { fail(b, err); });
      } else if (what === 'cancel') {
        showCancelConfirm(m, row, pin);
      }
    });
  }

  function showCancelConfirm(m, row, pin) {
    m.setTitle('예약을 취소할까요?');
    m.setBody(
      '<div class="confirm">' +
        '<p class="lead"><b>' + esc(row.name) + '</b> · ' + esc(row.slot) + ' 회차</p>' +
        '<p>취소하면 이 자리는 다른 친구가 예약할 수 있어요.</p>' +
        '<p class="form-error" role="alert" hidden></p>' +
        '<div class="actions"><button type="button" class="btn" data-do="back">돌아가기</button>' +
          '<button type="button" class="btn danger" data-do="yes">예약 취소</button></div>' +
      '</div>'
    );
    var box = $('.confirm', m.body);
    box.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-do]');
      if (!b) return;
      if (b.getAttribute('data-do') === 'back') { showManageMenu(m, row, pin); return; }
      setBusy(b, true, '취소하는 중…');
      S.call('cancel_booking', { p_id: row.id, p_pin: pin }).then(function () {
        m.close();
        toast(row.slot + ' 회차 예약을 취소했어요.', 'ok');
        loadList(true);
      }, function (err) {
        setBusy(b, false);
        formError(box, err.message);
      });
    });
  }

  /* ===================================================================
   * 7. 리더보드
   * =================================================================== */
  var loadBoard = makeLoader(function () {
    return S.call('leaderboard');
  }, function (rows, force) {
    S.board = rows || [];
    S.boardErr = null;
    S.boardAt = new Date();
    setNet(true);
    renderBoard(force);
  }, function (e) {
    S.boardErr = e;
    if (e.code === 'network') setNet(false);
    renderBoard(true);
  });

  var MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };

  function renderBoard(force) {
    var el = $('#board');
    if (S.boardAt) {
      $('#boardUpdated').textContent = '마지막 갱신 ' + clock(S.boardAt) + ' · ' + S.cfg.POLL_SECONDS + '초마다 자동으로 바뀌어요';
    }
    if (!S.board) {
      if (S.boardErr) {
        el.innerHTML = '<div class="load-error"><p>' + esc(S.boardErr.message) + '</p>' +
          '<button type="button" class="btn" data-board="retry">다시 시도</button></div>';
      }
      return;
    }
    var sig = JSON.stringify([S.board, S.cfg.MASK_NAMES]);
    if (!force && sig === S.boardSig) return;
    S.boardSig = sig;
    var rows = S.board.map(function (r) {
      return { rank: Number(r.rank), name: r.name, score: Number(r.score), slot: r.slot };
    });
    if (!rows.length) {
      el.innerHTML = '<div class="board-empty"><p class="board-empty-title">아직 기록이 없어요</p>' +
        '<p>첫 게임이 끝나면 여기에 순위가 올라와요. 예약하고 첫 기록의 주인공이 되어 보세요!</p>' +
        '<a class="btn primary" href="#reserve">예약하러 가기</a></div>';
      return;
    }
    var top = rows.filter(function (r) { return r.rank <= 3; });
    var rest = rows.filter(function (r) { return r.rank > 3; });
    var html = '<ol class="podium">' + top.map(function (r) {
      return '<li class="podium-item rank-' + r.rank + '">' +
        '<span class="medal" aria-hidden="true">' + MEDALS[r.rank] + '</span>' +
        '<span class="p-rank">' + r.rank + '위</span>' +
        '<span class="p-name">' + esc(publicName(r.name)) + '</span>' +
        '<span class="p-score">' + fmtScore(r.score) + '<small>점</small></span>' +
        '<span class="p-slot">' + esc(r.slot) + ' 회차</span>' +
      '</li>';
    }).join('') + '</ol>';
    if (rest.length) {
      html += '<div class="ranks-wrap"><ol class="ranks">' + rest.map(function (r) {
        return '<li class="rank-row">' +
          '<span class="r-rank">' + r.rank + '</span>' +
          '<span class="r-name">' + esc(publicName(r.name)) + '</span>' +
          '<span class="r-slot">' + esc(r.slot) + '</span>' +
          '<span class="r-score">' + fmtScore(r.score) + '</span>' +
        '</li>';
      }).join('') + '</ol></div>';
    }
    el.innerHTML = html;
    fitTvList();
  }

  /* 크게 보기 : 4위 아래 목록이 화면을 넘치면 천천히 위아래로 자동 스크롤 (전시용 태블릿은 아무도 스크롤하지 않으므로) */
  function fitTvList() {
    var box = $('#board .ranks-wrap');
    if (!box) return;
    var list = $('.ranks', box);
    box.classList.remove('is-scrolling');
    box.style.height = '';
    if (!document.body.classList.contains('tv')) return;
    var h = Math.max(140, Math.floor(root.innerHeight - box.getBoundingClientRect().top - 12));
    box.style.height = h + 'px';
    var over = list.scrollHeight - h;
    if (over > 8) {
      box.style.setProperty('--dist', over + 'px');
      box.style.setProperty('--dur', Math.max(14, Math.round(over / 22)) + 's');
      box.classList.add('is-scrolling');
    }
  }

  function enterTv() {
    document.body.classList.add('tv');
    setTimeout(fitTvList, 60);
    var el = document.documentElement;
    var rq = el.requestFullscreen || el.webkitRequestFullscreen;
    if (rq) {
      try { var pr = rq.call(el); if (pr && pr.catch) pr.catch(function () { /* 무시 */ }); } catch (e) { /* 무시 */ }
    }
  }

  function exitTv() {
    if (!document.body.classList.contains('tv')) return;
    document.body.classList.remove('tv');
    fitTvList();
    var fs = document.fullscreenElement || document.webkitFullscreenElement;
    var ex = document.exitFullscreen || document.webkitExitFullscreen;
    if (fs && ex) {
      try { var pr = ex.call(document); if (pr && pr.catch) pr.catch(function () { /* 무시 */ }); } catch (e) { /* 무시 */ }
    }
  }

  /* ===================================================================
   * 8. 체험 안내 (그림 크게 보기)
   * =================================================================== */
  var pendingAnchor = null;

  function guideJump(anchor) {
    $all('.guide-nav a').forEach(function (a) {
      a.classList.toggle('is-active', a.getAttribute('data-guide') === (anchor === 'top' ? 'overview' : anchor));
    });
    if (!anchor || anchor === 'top') { root.scrollTo(0, 0); pendingAnchor = null; return; }
    var sec = document.getElementById('sec-' + anchor);
    if (!sec) return;
    pendingAnchor = { id: anchor, at: Date.now() };
    sec.scrollIntoView({ block: 'start' });
  }

  function onGuideImageLoad() {
    // 그림이 늦게 뜨면 위치가 밀리므로, 방금 바로가기를 눌렀다면 다시 맞춘다
    if (pendingAnchor && Date.now() - pendingAnchor.at < 4000) {
      var sec = document.getElementById('sec-' + pendingAnchor.id);
      if (sec) sec.scrollIntoView({ block: 'start' });
    }
  }

  function openLightbox(src, title) {
    var lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.setAttribute('role', 'dialog');
    lb.setAttribute('aria-modal', 'true');
    lb.setAttribute('aria-label', title + ' 크게 보기');
    lb.innerHTML =
      '<div class="lb-bar">' +
        '<p class="lb-title">' + esc(title) + '</p>' +
        '<button type="button" class="lb-btn" data-zoom="-1" aria-label="축소">－</button>' +
        '<button type="button" class="lb-btn" data-zoom="1" aria-label="확대">＋</button>' +
        '<a class="lb-btn lb-link" href="' + esc(src) + '" target="_blank" rel="noopener">새 창</a>' +
        '<button type="button" class="lb-btn lb-close" data-lb-close>닫기</button>' +
      '</div>' +
      '<div class="lb-stage"><img src="' + esc(src) + '" alt="' + esc(title) + '"></div>';
    document.body.appendChild(lb);
    document.body.classList.add('has-modal');
    var levels = [1, 1.6, 2.4, 3.5];
    var level = 0;
    var img = $('img', lb);
    var stage = $('.lb-stage', lb);
    function apply() {
      lb.classList.toggle('is-zoomed', level > 0);
      img.style.width = level > 0 ? Math.round(levels[level] * 100) + '%' : '';
    }
    function close() {
      lb.remove();
      if (!modals.length) document.body.classList.remove('has-modal');
      document.removeEventListener('keydown', onKey, true);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    }
    document.addEventListener('keydown', onKey, true);
    lb.addEventListener('click', function (e) {
      if (e.target.closest('[data-lb-close]')) { close(); return; }
      var z = e.target.closest('[data-zoom]');
      if (z) {
        level = Math.max(0, Math.min(levels.length - 1, level + (+z.getAttribute('data-zoom'))));
        apply();
        return;
      }
      if (e.target === stage) close();
    });
    img.addEventListener('dblclick', function () { level = level > 0 ? 0 : 2; apply(); });
    $('.lb-close', lb).focus();
  }

  /* ===================================================================
   * 9. 관리자 화면 (#admin)
   * =================================================================== */
  function adminCall(fn, params) {
    var p = { p_pw: S.admin.pw };
    for (var k in params) p[k] = params[k];
    return S.call(fn, p).catch(function (err) {
      if (err.code === 'admin_auth') {
        adminLogout('관리자 비밀번호가 바뀌었거나 맞지 않아요. 다시 로그인하세요.');
      }
      throw err;
    });
  }

  function adminLogout(msg) {
    S.admin.pw = null;
    S.admin.rows = null;
    S.admin.sig = '';
    sessionDel(ADMIN_SESSION_KEY);
    renderAdminLogin(msg);
  }

  var loadAdminRows = makeLoader(function () {
    if (!S.admin.pw) return Promise.resolve(null);
    return adminCall('admin_list', {});
  }, function (rows, force) {
    if (!S.admin.pw || rows == null) return;
    S.admin.rows = rows;
    S.admin.err = null;
    setNet(true);
    renderAdmin(force);
  }, function (e) {
    S.admin.err = e;
    if (e.code === 'network') setNet(false);
    if (e.code !== 'admin_auth') {
      if (!S.admin.rows) $('#adminRoot').innerHTML = '<div class="load-error"><p>' + esc(e.message) + '</p></div>';
      else toast(e.message, 'warn');
    }
  });

  function loadAdmin(force) {
    if (!S.admin.pw) { if (!$('#adminLogin')) renderAdminLogin(); return Promise.resolve(); }
    return loadAdminRows(force);
  }

  function renderAdminLogin(msg) {
    var demo = S.mode === 'demo';
    $('#adminRoot').innerHTML =
      '<form class="admin-login form" id="adminLogin" novalidate>' +
        '<h2 class="view-title">관리자</h2>' +
        '<p class="muted">부스 운영진만 사용하는 화면입니다.</p>' +
        '<label class="field"><span class="field-label">관리자 비밀번호</span>' +
          '<input name="pw" type="password" autocomplete="current-password"></label>' +
        (demo ? '<p class="hint">데모 모드 비밀번호 : <b>' + DEMO_ADMIN_PASSWORD + '</b></p>' : '') +
        '<p class="form-error" role="alert"' + (msg ? '' : ' hidden') + '>' + esc(msg || '') + '</p>' +
        '<div class="actions"><a class="btn" href="#reserve">예약 화면으로</a>' +
          '<button type="submit" class="btn primary">로그인</button></div>' +
      '</form>';
    var form = $('#adminLogin');
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (!S.call) { formError(form, '서버 연결을 준비하는 중이에요. 잠시 후 다시 시도하세요.'); return; }
      var pw = form.querySelector('[name=pw]').value.trim();
      if (!pw) { formError(form, '비밀번호를 입력하세요.'); return; }
      var btn = form.querySelector('[type=submit]');
      setBusy(btn, true, '확인 중…');
      S.call('admin_check', { p_pw: pw }).then(function (ok) {
        setBusy(btn, false);
        if (ok !== true) { formError(form, MSG.adminAuth); return; }
        S.admin.pw = pw;
        sessionSet(ADMIN_SESSION_KEY, pw);
        $('#adminRoot').innerHTML = '<p class="loading">불러오는 중…</p>';
        loadAdmin(true);
      }, function (err) {
        setBusy(btn, false);
        formError(form, err.message);
      });
    });
  }

  /* 자동 새로고침 때 입력 중인 점수가 지워지지 않도록 보관 → 복원 */
  function snapshotAdminInputs() {
    var snap = { dirty: {}, focusId: null, sel: null };
    $all('#adminRoot input.score-in').forEach(function (i) {
      if (i.value !== i.getAttribute('data-saved')) snap.dirty[i.getAttribute('data-id')] = i.value;
    });
    var a = document.activeElement;
    if (a && a.classList && a.classList.contains('score-in') && $('#adminRoot').contains(a)) {
      snap.focusId = a.getAttribute('data-id');
      try { snap.sel = [a.selectionStart, a.selectionEnd]; } catch (e) { snap.sel = null; }
    }
    return snap;
  }

  function restoreAdminInputs(snap) {
    Object.keys(snap.dirty).forEach(function (id) {
      var i = $('#adminRoot input.score-in[data-id="' + id + '"]');
      if (i) { i.value = snap.dirty[id]; markScore(i); }
    });
    if (snap.focusId) {
      var f = $('#adminRoot input.score-in[data-id="' + snap.focusId + '"]');
      if (f) {
        f.focus({ preventScroll: true });
        if (snap.sel) { try { f.setSelectionRange(snap.sel[0], snap.sel[1]); } catch (e) { /* 무시 */ } }
      }
    }
  }

  function markScore(input) {
    var dirty = input.value !== input.getAttribute('data-saved');
    input.classList.toggle('is-dirty', dirty);
  }

  function renderAdmin(force) {
    var rows = S.admin.rows;
    if (!rows) return;
    var sig = JSON.stringify(rows);
    if (!force && sig === S.admin.sig && $('#adminMain')) return;
    S.admin.sig = sig;
    var snap = snapshotAdminInputs();
    var c = S.cfg;
    var bySlot = groupBySlot(rows);
    var scored = rows.filter(function (r) { return r.score != null; }).length;
    var walkins = rows.filter(function (r) { return !r.has_pin; }).length;
    var orphan = rows.filter(function (r) { return S.slots.indexOf(r.slot) < 0; });

    function rowHtml(r, idx) {
      var color = SEAT_COLORS[idx % SEAT_COLORS.length];
      var saved = r.score == null ? '' : String(r.score);
      return '<li class="arow" data-id="' + esc(r.id) + '">' +
        '<span class="arow-name"><span class="dot dot--' + color + '" aria-hidden="true"></span>' +
          '<span class="aname">' + esc(r.name) + '</span>' +
          (r.has_pin ? '' : '<span class="tag">현장</span>') +
          (r.locked ? '<span class="tag tag--lock">잠김</span>' : '') +
          (S.slots.indexOf(r.slot) < 0 ? '<span class="tag tag--warn">' + esc(r.slot) + '</span>' : '') +
        '</span>' +
        '<span class="arow-score">' +
          '<input class="score-in" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off"' +
          ' data-id="' + esc(r.id) + '" data-saved="' + esc(saved) + '" value="' + esc(saved) + '"' +
          ' aria-label="' + esc(r.name + ' 점수') + '" placeholder="점수">' +
          '<button type="button" class="btn small" data-a="save" data-id="' + esc(r.id) + '">저장</button>' +
        '</span>' +
        '<span class="arow-acts">' +
          '<button type="button" class="btn small ghost" data-a="edit" data-id="' + esc(r.id) + '">수정</button>' +
          '<button type="button" class="btn small ghost" data-a="replace" data-id="' + esc(r.id) + '">교체</button>' +
          '<button type="button" class="btn small ghost danger-text" data-a="del" data-id="' + esc(r.id) + '">삭제</button>' +
        '</span>' +
      '</li>';
    }

    var slotsHtml = S.slots.map(function (slot) {
      var people = bySlot[slot] || [];
      var over = people.length > c.CAPACITY;
      return '<section class="aslot" data-slot="' + esc(slot) + '">' +
        '<header class="aslot-head">' +
          '<h3>' + esc(slot) + ' ~ ' + esc(slotEnd(slot, c)) + '</h3>' +
          '<span class="acount' + (over ? ' is-over' : '') + '">' + people.length + '/' + c.CAPACITY + '명</span>' +
          '<button type="button" class="btn small" data-a="add" data-slot="' + esc(slot) + '">+ 현장 참가자</button>' +
        '</header>' +
        (people.length ? '<ul class="arows">' + people.map(rowHtml).join('') + '</ul>'
                       : '<p class="aempty">예약 없음</p>') +
      '</section>';
    }).join('');

    var orphanHtml = orphan.length
      ? '<section class="aslot aslot--orphan"><header class="aslot-head"><h3>설정에 없는 시간</h3>' +
        '<span class="acount">' + orphan.length + '명</span></header>' +
        '<p class="muted">config.js 의 운영 시간이 바뀌어 예약 화면에 보이지 않는 예약입니다. [수정] 으로 시간을 옮기세요.</p>' +
        '<ul class="arows">' + orphan.map(rowHtml).join('') + '</ul></section>'
      : '';

    $('#adminRoot').innerHTML =
      '<div class="admin" id="adminMain">' +
        '<div class="admin-bar">' +
          '<h2 class="view-title">관리자</h2>' +
          '<p class="admin-stats">예약 <b>' + rows.length + '</b>명 · 점수 입력 <b>' + scored + '</b>명 · 현장 <b>' + walkins + '</b>명' +
            (S.mode === 'demo' ? ' <span class="tag">데모</span>' : '') + '</p>' +
          '<div class="admin-tools">' +
            '<button type="button" class="btn small" data-a="refresh">새로고침</button>' +
            '<a class="btn small" href="#board">리더보드</a>' +
            '<button type="button" class="btn small ghost" data-a="logout">로그아웃</button>' +
          '</div>' +
        '</div>' +
        '<p class="admin-help">점수를 입력하고 <kbd>Enter</kbd> 를 누르면 저장되고 다음 칸으로 넘어갑니다. ' +
          '칸을 비우고 저장하면 점수가 지워집니다.</p>' +
        orphanHtml + slotsHtml +
        '<section class="danger-zone">' +
          '<h3>테스트 데이터 정리</h3>' +
          '<p class="muted">행사 전에 시험 삼아 넣은 예약(이병헌, 원빈 등)과 점수를 모두 지웁니다. 되돌릴 수 없어요.</p>' +
          '<button type="button" class="btn danger" data-a="wipe">테스트 데이터 전체 삭제</button>' +
        '</section>' +
      '</div>';
    restoreAdminInputs(snap);
  }

  function adminRow(id) {
    var rows = S.admin.rows || [];
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
    return null;
  }

  function afterAdminChange(msg) {
    if (msg) toast(msg, 'ok');
    S.listSig = '';
    S.boardSig = '';
    return loadAdmin(true);
  }

  function saveScore(input, moveNext) {
    var id = input.getAttribute('data-id');
    var raw = input.value.replace(/[,\s]/g, '');
    var score = null;
    if (raw !== '') {
      if (!/^\d{1,6}$/.test(raw)) { input.classList.add('is-bad'); toast(MSG.score, 'warn'); input.focus(); return; }
      score = parseInt(raw, 10);
    }
    input.classList.remove('is-bad');
    // Enter 로 저장할 때는 응답을 기다리지 않고 바로 다음 칸으로 (빠르게 연달아 입력 가능)
    if (moveNext) {
      var all = $all('#adminRoot input.score-in');
      var nx = all[all.indexOf(input) + 1];
      if (nx) {
        nx.focus({ preventScroll: true });
        nx.select();
        nx.scrollIntoView({ block: 'nearest' });   // 위쪽 고정 메뉴 아래로 보이게 (scroll-padding-top)
      } else {
        input.blur();
      }
    }
    var r = adminRow(id);
    var name = r ? r.name : '';
    // 저장하는 동안 화면이 새로 그려질 수 있으므로 매번 id 로 현재 칸·버튼을 다시 찾는다
    function curInput() { return $('#adminRoot input.score-in[data-id="' + id + '"]'); }
    function curBtn() { return $('#adminRoot button[data-a="save"][data-id="' + id + '"]'); }
    setBusy(curBtn(), true, '저장…');
    adminCall('admin_set_score', { p_id: id, p_score: score }).then(function () {
      setBusy(curBtn(), false);
      var el = curInput();
      if (el) {
        el.setAttribute('data-saved', score == null ? '' : String(score));
        if (document.activeElement !== el) el.value = score == null ? '' : String(score);
        markScore(el);
      }
      return afterAdminChange(score == null ? name + ' 점수를 지웠어요.' : name + ' ' + fmtScore(score) + '점 저장');
    }, function (err) {
      setBusy(curBtn(), false);
      var el = curInput();
      if (el) el.classList.add('is-bad');
      if (err.code !== 'admin_auth') toast((name ? name + ' : ' : '') + err.message, 'warn');
    });
  }

  function slotOptions(current, allowFull) {
    var c = S.cfg;
    var bySlot = groupBySlot(S.admin.rows);
    var list = S.slots.slice();
    if (current && list.indexOf(current) < 0) list.unshift(current);
    return list.map(function (s) {
      var n = (bySlot[s] || []).length;
      var label = s + ' (' + n + '/' + c.CAPACITY + '명)' + (S.slots.indexOf(s) < 0 ? ' - 설정에 없음' : '');
      return '<option value="' + esc(s) + '"' + (s === current ? ' selected' : '') +
        (!allowFull && n >= c.CAPACITY && s !== current ? ' disabled' : '') + '>' + esc(label) + '</option>';
    }).join('');
  }

  function adminNameModal(opts) {
    openModal({
      title: opts.title,
      html:
        '<form class="form" novalidate>' +
          (opts.lead ? '<p class="lead">' + opts.lead + '</p>' : '') +
          '<label class="field"><span class="field-label">' + esc(opts.label || '이름') + '</span>' +
            '<input name="aname" type="text" maxlength="20" autocomplete="off" value="' + esc(opts.value || '') + '"></label>' +
          (opts.withSlot ? '<label class="field"><span class="field-label">시간</span>' +
            '<select name="aslot">' + slotOptions(opts.slot, true) + '</select></label>' : '') +
          (opts.hint ? '<p class="hint">' + opts.hint + '</p>' : '') +
          '<p class="form-error" role="alert" hidden></p>' +
          '<div class="actions"><button type="button" class="btn" data-dismiss>닫기</button>' +
            '<button type="submit" class="btn primary">' + esc(opts.submit) + '</button></div>' +
        '</form>',
      onOpen: function (m) {
        var form = $('form', m.body);
        form.addEventListener('submit', function (ev) {
          ev.preventDefault();
          var name = cleanName(form.querySelector('[name=aname]').value);
          var slotSel = form.querySelector('[name=aslot]');
          try { validName(name); } catch (err) { formError(form, err.message); return; }
          var btn = form.querySelector('[type=submit]');
          setBusy(btn, true);
          opts.run(name, slotSel ? slotSel.value : null).then(function (msg) {
            m.close();
            afterAdminChange(msg);
          }, function (err) {
            setBusy(btn, false);
            if (err.code === 'admin_auth') { m.close(); return; }
            formError(form, err.message);
          });
        });
      }
    });
  }

  function onAdminClick(e) {
    var b = e.target.closest('[data-a]');
    if (!b) return;
    var a = b.getAttribute('data-a');
    var id = b.getAttribute('data-id');
    var r = id ? adminRow(id) : null;
    if (a === 'refresh') { loadAdmin(true).then(function () { toast('새로 불러왔어요.'); }); return; }
    if (a === 'logout') { adminLogout(); return; }
    if (a === 'save') { var inp = $('#adminRoot input.score-in[data-id="' + id + '"]'); if (inp) saveScore(inp, false); return; }
    if (a === 'add') {
      var slot = b.getAttribute('data-slot');
      adminNameModal({
        title: slot + ' 회차 현장 참가자 추가',
        label: '참가자 이름 (실명)',
        hint: '비밀번호 없이 등록됩니다. 정원을 넘겨도 추가돼요.',
        submit: '추가',
        run: function (name) {
          return adminCall('admin_add', { p_slot: slot, p_name: name }).then(function () {
            return name + ' 님을 ' + slot + ' 회차에 추가했어요.';
          });
        }
      });
      return;
    }
    if (!r) return;
    if (a === 'edit') {
      adminNameModal({
        title: '예약 수정',
        lead: '<b>' + esc(r.name) + '</b> · ' + esc(r.slot) + ' 회차',
        value: r.name, withSlot: true, slot: r.slot,
        hint: '관리자는 정원을 넘겨서 옮길 수도 있어요. 저장하면 비밀번호 잠금도 풀립니다.',
        submit: '저장',
        run: function (name, slot) {
          return adminCall('admin_update', {
            p_id: r.id, p_slot: slot !== r.slot ? slot : null, p_name: name !== r.name ? name : null
          }).then(function () { return name + ' 님 예약을 수정했어요.'; });
        }
      });
      return;
    }
    if (a === 'replace') {
      adminNameModal({
        title: '현장 대기자로 교체',
        lead: '<b>' + esc(r.name) + '</b> 님 (' + esc(r.slot) + ') 이 오지 않았나요? 기다리는 참가자 이름을 넣으면 이 자리를 넘겨줍니다.',
        label: '현장 대기자 이름 (실명)',
        hint: '원래 예약의 비밀번호와 점수는 지워집니다.',
        submit: '교체',
        run: function (name) {
          return adminCall('admin_replace', { p_id: r.id, p_name: name }).then(function () {
            return r.name + ' → ' + name + ' 교체했어요.';
          });
        }
      });
      return;
    }
    if (a === 'del') {
      openModal({
        title: '예약 삭제',
        html: '<div class="confirm"><p class="lead"><b>' + esc(r.name) + '</b> · ' + esc(r.slot) + ' 회차</p>' +
          '<p>이 예약을 삭제할까요? 점수도 함께 지워집니다.</p>' +
          '<p class="form-error" role="alert" hidden></p>' +
          '<div class="actions"><button type="button" class="btn" data-dismiss>닫기</button>' +
          '<button type="button" class="btn danger" data-yes>삭제</button></div></div>',
        onOpen: function (m) {
          $('[data-yes]', m.body).addEventListener('click', function (ev) {
            var btn = ev.currentTarget;
            setBusy(btn, true, '삭제 중…');
            adminCall('admin_delete', { p_id: r.id }).then(function () {
              m.close();
              afterAdminChange(r.name + ' 님 예약을 삭제했어요.');
            }, function (err) {
              setBusy(btn, false);
              if (err.code === 'admin_auth') { m.close(); return; }
              formError($('.confirm', m.body), err.message);
            });
          });
        }
      });
      return;
    }
  }

  function openWipeModal() {
    openModal({
      title: '테스트 데이터 전체 삭제',
      tone: 'danger',
      html: '<form class="form" novalidate>' +
        '<p>예약 <b>' + (S.admin.rows ? S.admin.rows.length : 0) + '</b>건과 모든 점수를 지웁니다. 되돌릴 수 없어요.</p>' +
        '<label class="field"><span class="field-label">확인을 위해 <b>전체삭제</b> 를 입력하세요</span>' +
          '<input name="confirm" type="text" autocomplete="off" placeholder="전체삭제"></label>' +
        '<p class="form-error" role="alert" hidden></p>' +
        '<div class="actions"><button type="button" class="btn" data-dismiss>닫기</button>' +
          '<button type="submit" class="btn danger" disabled>전체 삭제</button></div>' +
        '</form>',
      onOpen: function (m) {
        var form = $('form', m.body);
        var input = form.querySelector('[name=confirm]');
        var btn = form.querySelector('[type=submit]');
        input.addEventListener('input', function () { btn.disabled = input.value.trim() !== '전체삭제'; });
        form.addEventListener('submit', function (ev) {
          ev.preventDefault();
          if (input.value.trim() !== '전체삭제') { formError(form, MSG.confirmAll); return; }
          setBusy(btn, true, '삭제 중…');
          adminCall('admin_delete_all', { p_confirm: input.value.trim() }).then(function (n) {
            m.close();
            afterAdminChange('예약 ' + (n || 0) + '건을 모두 삭제했어요.');
          }, function (err) {
            setBusy(btn, false);
            if (err.code === 'admin_auth') { m.close(); return; }
            formError(form, err.message);
          });
        });
      }
    });
  }

  /* ===================================================================
   * 10. 시작
   * =================================================================== */
  function fillTexts() {
    var c = S.cfg;
    var parts = String(c.BOOTH_TITLE).split(/\s*:\s*/);
    var main = parts[0] || c.BOOTH_TITLE;
    var sub = parts.slice(1).join(' : ');
    $('#eventName').textContent = c.EVENT_NAME;
    $('#titleMain').textContent = main;
    $('#titleSub').textContent = sub;
    $('#titleSub').hidden = !sub;
    $('#tvTitle').textContent = main;
    $('#boothNo').textContent = c.BOOTH_NO;
    $('.booth').hidden = !c.BOOTH_NO;
    $('#dateLabel').textContent = (c.DATE_LABEL ? c.DATE_LABEL + ' ' : '') + c.START + '~' + c.END;
    $('#placeLabel').textContent = c.PLACE;
    $('#placeLabel').hidden = !c.PLACE;
    $('#footText').textContent = c.BOOTH_TITLE + (c.BOOTH_NO ? ' · ' + c.BOOTH_NO + ' 부스' : '');
    document.title = c.BOOTH_TITLE + ' | 체험 예약';
    var notes = c.NOTICES.map(function (t) {
      return String(t).replace(/\{정원\}/g, c.CAPACITY).replace(/\{분\}/g, c.SLOT_MINUTES);
    });
    if (c.MASK_NAMES) notes.push('예약 현황과 리더보드에는 이름 가운데 글자가 * 로 가려져 보여요.');
    $('#noticeList').innerHTML = notes.map(function (t, i) {
      return '<li class="led-' + SEAT_COLORS[i % SEAT_COLORS.length] + '">' + esc(t) + '</li>';
    }).join('');
    $('.notice').hidden = !notes.length;   // 안내 문구를 모두 지우면 상자도 숨김
  }

  function showModeBanner(kind, text) {
    var b = $('#modeBanner');
    b.className = 'mode-banner mode-banner--' + kind;
    b.innerHTML = text;
    b.hidden = false;
  }

  function showFatal(msg, retry) {
    showModeBanner('error', '<b>설정을 확인해 주세요</b> ' + esc(msg) +
      (retry ? ' <button type="button" class="btn small" id="retryLib">다시 시도</button>' : ''));
    var t = '<li class="load-error"><p>' + esc(msg) + '</p></li>';
    $('#slotList').innerHTML = t;
    $('#board').innerHTML = '<div class="load-error"><p>' + esc(msg) + '</p></div>';
    var r = $('#retryLib');
    if (r) r.addEventListener('click', function () { location.reload(); });
  }

  function setupBackend() {
    var c = S.cfg;
    if (!c.SUPABASE_URL && !c.SUPABASE_KEY) {
      S.mode = 'demo';
      S.call = makeCaller(createMockBackend({
        storage: localStore(DEMO_STORAGE_KEY), capacity: c.CAPACITY,
        adminPassword: DEMO_ADMIN_PASSWORD, latency: 120
      }));
      showModeBanner('demo', '<b>데모 모드</b> 서버에 연결되지 않아 예약이 이 기기에만 저장돼요. ' +
        '(운영자: config.js 에 Supabase 주소와 키를 넣으세요)');
      return Promise.resolve();
    }
    var problem = (!c.SUPABASE_URL ? 'config.js 의 SUPABASE_URL 이 비어 있어요.' : urlProblem(c.SUPABASE_URL)) ||
                  keyProblem(c.SUPABASE_KEY);
    if (problem) {
      S.mode = 'error';
      showFatal(problem, false);
      return Promise.resolve();
    }
    return loadSupabaseLib(15000).then(function () {
      S.mode = 'live';
      S.call = makeCaller(createSupabaseBackend(c.SUPABASE_URL, c.SUPABASE_KEY));
    }, function () {
      S.mode = 'error';
      showFatal('서버 연결 도구(supabase-js)를 불러오지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도하세요.', true);
    });
  }

  function bindEvents() {
    root.addEventListener('hashchange', route);
    $('#slotList').addEventListener('click', onSlotClick);
    $('#board').addEventListener('click', function (e) {
      if (e.target.closest('[data-board="retry"]')) { S.boardErr = null; loadBoard(true); }
    });
    $('#tvBtn').addEventListener('click', enterTv);
    $('#tvExit').addEventListener('click', exitTv);
    $('#view-guide').addEventListener('click', function (e) {
      var z = e.target.closest('.zoom');
      if (z) openLightbox(z.getAttribute('data-src'), z.getAttribute('data-title'));
    });
    $all('#view-guide img').forEach(function (img) { img.addEventListener('load', onGuideImageLoad); });
    $('#adminRoot').addEventListener('click', function (e) {
      if (e.target.closest('[data-a="wipe"]')) { openWipeModal(); return; }
      onAdminClick(e);
    });
    $('#adminRoot').addEventListener('keydown', function (e) {
      var t = e.target;
      if (!t.classList || !t.classList.contains('score-in')) return;
      if (e.key === 'Enter') { e.preventDefault(); saveScore(t, true); }
      if (e.key === 'Escape') { t.value = t.getAttribute('data-saved'); markScore(t); t.blur(); }
    });
    $('#adminRoot').addEventListener('input', function (e) {
      var t = e.target;
      if (t.classList && t.classList.contains('score-in')) {
        var v = t.value.replace(/[^\d]/g, '').slice(0, 6);
        if (v !== t.value) t.value = v;
        t.classList.remove('is-bad');
        markScore(t);
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var m = topModal();
      if (m) { m.close(); return; }
      if (document.body.classList.contains('tv')) exitTv();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') refreshCurrent(false);
    });
    var fitTimer = null;
    function refit() { clearTimeout(fitTimer); fitTimer = setTimeout(fitTvList, 150); }
    root.addEventListener('resize', refit);
    document.addEventListener('fullscreenchange', refit);
    document.addEventListener('webkitfullscreenchange', refit);
  }

  function boot() {
    S.cfg = normalizeConfig(root.BOOTH_CONFIG);
    S.slots = computeSlots(S.cfg);
    S.nowOverride = parseNowOverride(location.search);
    S.admin.pw = sessionGet(ADMIN_SESSION_KEY);
    fillTexts();
    bindEvents();
    if (/[?&]tv=1/.test(location.search) && (location.hash === '#board')) document.body.classList.add('tv');
    route();
    setupBackend().then(function () {
      refreshCurrent(true);
      setInterval(function () {
        if (document.visibilityState !== 'hidden') refreshCurrent(false);
      }, S.cfg.POLL_SECONDS * 1000);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
