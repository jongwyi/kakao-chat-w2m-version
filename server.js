require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── 한국어 날짜 파서 (Claude API 없이도 동작하는 폴백) ──────────────────
function pad(n) { return String(n).padStart(2, '0'); }

function toDateStr(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }

function getDaysInMonth(y, m) { return new Date(y, m, 0).getDate(); } // m=1..12

function parseKoreanDates(text) {
  const now = new Date();
  let year = now.getFullYear();
  let baseMonth = now.getMonth() + 1; // 1-indexed

  const results = new Set();

  // 요일 이름 매핑
  const dayNames = { '일': 0, '월': 1, '화': 2, '수': 3, '목': 4, '금': 5, '토': 6 };
  const weekOrdinals = { '첫째': 1, '두번째': 2, '둘째': 2, '셋째': 3, '넷째': 4, '다섯째': 5 };

  // 어떤 달 기준인지 결정
  let targetMonth = baseMonth;
  let targetYear = year;

  const nextMonthMatch = text.match(/다음\s*달|다음\s*월/);
  if (nextMonthMatch) {
    targetMonth = baseMonth === 12 ? 1 : baseMonth + 1;
    if (baseMonth === 12) targetYear++;
  }

  const specificMonthMatch = text.match(/(\d{1,2})\s*월/);
  if (specificMonthMatch) {
    targetMonth = parseInt(specificMonthMatch[1]);
    if (targetMonth < baseMonth - 1) targetYear++; // 이미 지난 달이면 내년
  }

  // 평일 필터 여부
  const weekdayOnly = /평일|평일만|주말\s*제외/.test(text);
  // 주말 필터 여부
  const weekendOnly = /주말|주말만|평일\s*제외/.test(text);

  function isAllowed(date) {
    const dow = date.getDay();
    if (weekdayOnly) return dow >= 1 && dow <= 5;
    if (weekendOnly) return dow === 0 || dow === 6;
    return true;
  }

  // 패턴 1: "N월 M일" 또는 "M일" (단일/다중 날짜)
  const specificDays = [...text.matchAll(/(?:(\d{1,2})\s*월\s*)?(\d{1,2})\s*일/g)];
  if (specificDays.length > 0) {
    for (const m of specificDays) {
      const mo = m[1] ? parseInt(m[1]) : targetMonth;
      const d = parseInt(m[2]);
      const y = mo < baseMonth - 1 ? targetYear + 1 : targetYear;
      const date = new Date(y, mo - 1, d);
      if (isAllowed(date)) results.add(toDateStr(y, mo, d));
    }
    if (results.size > 0) return [...results].sort();
  }

  // 패턴 2: "N월 첫째/둘째/셋째/넷째 주" — 월요일 기준 ISO 주
  const weekOrdMatch = text.match(/(첫째|둘째|두번째|셋째|넷째|다섯째)\s*주/);
  if (weekOrdMatch) {
    const ord = weekOrdinals[weekOrdMatch[1]]; // 1..5
    // 해당 달의 첫 번째 월요일 찾기
    let firstMonday = 1;
    const dow1 = new Date(targetYear, targetMonth - 1, 1).getDay(); // 0=Sun
    if (dow1 === 0) firstMonday = 2;      // 일요일 → 다음날(월)
    else if (dow1 > 1) firstMonday = 9 - dow1; // 화~토 → 다음 주 월
    // else dow1 === 1: 이미 월요일
    const weekMonday = firstMonday + (ord - 1) * 7;
    for (let dd = weekMonday; dd < weekMonday + 7; dd++) {
      if (dd < 1 || dd > getDaysInMonth(targetYear, targetMonth)) continue;
      const date = new Date(targetYear, targetMonth - 1, dd);
      if (isAllowed(date)) results.add(toDateStr(targetYear, targetMonth, dd));
    }
    if (results.size > 0) return [...results].sort();
  }

  // 패턴 3: "이번 주 + 요일들"
  const thisWeekMatch = /이번\s*주|이번주/.test(text);
  const nextWeekMatch = /다음\s*주|다음주/.test(text);
  const dayMatches = [...text.matchAll(/([월화수목금토일])\s*(?:요일)?/g)];

  if ((thisWeekMatch || nextWeekMatch) && dayMatches.length > 0) {
    const offset = nextWeekMatch ? 7 : 0;
    const todayDow = now.getDay();
    for (const dm of dayMatches) {
      const targetDow = dayNames[dm[1]];
      if (targetDow === undefined) continue;
      let diff = targetDow - todayDow + offset;
      if (!nextWeekMatch && diff < 0) diff += 7;
      const date = new Date(now);
      date.setDate(now.getDate() + diff);
      if (isAllowed(date)) results.add(toDateStr(date.getFullYear(), date.getMonth() + 1, date.getDate()));
    }
    if (results.size > 0) return [...results].sort();
  }

  // 패턴 4: 특정 요일들 언급 (이번 주/다음 주 없이)
  if (dayMatches.length > 0 && !weekOrdMatch) {
    const todayDow = now.getDay();
    for (const dm of dayMatches) {
      const targetDow = dayNames[dm[1]];
      if (targetDow === undefined) continue;
      let diff = targetDow - todayDow;
      if (diff <= 0) diff += 7;
      const date = new Date(now);
      date.setDate(now.getDate() + diff);
      if (isAllowed(date)) results.add(toDateStr(date.getFullYear(), date.getMonth() + 1, date.getDate()));
    }
    if (results.size > 0) return [...results].sort();
  }

  // 패턴 5: "이번 달 평일/주말/토요일마다" 등
  if (/이번\s*달|이번달|이번\s*월/.test(text) || weekdayOnly || weekendOnly) {
    const daysInMonth = getDaysInMonth(targetYear, targetMonth);
    for (let dd = 1; dd <= daysInMonth; dd++) {
      const date = new Date(targetYear, targetMonth - 1, dd);
      if (isAllowed(date)) results.add(toDateStr(targetYear, targetMonth, dd));
    }
    if (results.size > 0) return [...results].sort();
  }

  // 패턴 6: 해당 달 전체 (N월만 언급)
  if (specificMonthMatch) {
    const daysInMonth = getDaysInMonth(targetYear, targetMonth);
    for (let dd = 1; dd <= daysInMonth; dd++) {
      const date = new Date(targetYear, targetMonth - 1, dd);
      if (isAllowed(date)) results.add(toDateStr(targetYear, targetMonth, dd));
    }
    return [...results].sort();
  }

  return [];
}

// ── when2meet 방 생성 ───────────────────────────────────────────────────────
app.post('/create-when2meet', async (req, res) => {
  const { eventName, dates, noEarlierThan = 9, noLaterThan = 18, timeZone = 'Asia/Seoul' } = req.body;

  if (!eventName || !dates || dates.length === 0) {
    return res.status(400).json({ error: '이벤트 이름과 날짜를 입력해주세요.' });
  }

  const params = new URLSearchParams({
    NewEventName: eventName,
    DateTypes: 'SpecificDates',
    PossibleDates: dates.join('|'),
    NoEarlierThan: String(noEarlierThan),
    NoLaterThan: String(noLaterThan),
    TimeZone: timeZone,
  });

  try {
    const response = await fetch('https://www.when2meet.com/SaveNewEvent.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      redirect: 'manual',
    });

    const text = await response.text();
    const match = text.match(/window\.location\s*=\s*['"]([^'"]+)['"]/);
    if (match) {
      const rel = match[1].replace(/^\.\//, '/');
      const eventUrl = rel.startsWith('http') ? rel : `https://www.when2meet.com${rel}`;
      return res.json({ url: eventUrl });
    }

    const location = response.headers.get('location');
    if (location) {
      const eventUrl = location.startsWith('http') ? location : `https://www.when2meet.com${location}`;
      return res.json({ url: eventUrl });
    }

    res.status(500).json({ error: '방 생성에 실패했습니다.' });
  } catch (err) {
    console.error('when2meet 요청 오류:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 방 이름 파서 (JS 폴백용) ────────────────────────────────────────────────
function parseRoomName(text) {
  // 따옴표로 감싼 텍스트: "스터디", '독서모임', 〈제목〉 등
  const quoted = text.match(/["""'''「」『』<>《》](.*?)["""'''」』>》]/u);
  if (quoted) return quoted[1].trim();
  // "이름", "제목", "방 이름" 키워드 뒤 텍스트
  const labeled = text.match(/(?:방\s*이름|제목|이름)\s*[은는이가]?\s*[：:은는]?\s*([^\s,，.。!?]+(?:\s+[^\s,，.。!?]+)*)/);
  if (labeled) return labeled[1].trim();
  return null;
}

// ── 날짜 + 방 이름 추출 (Claude API 우선, 실패시 JS 파서 폴백) ──────────────
app.post('/extract-dates', async (req, res) => {
  const { userText } = req.body;
  if (!userText) return res.status(400).json({ error: '텍스트를 입력해주세요.' });

  // 1) Claude API 시도
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const client = new Anthropic();
      const today = new Date().toISOString().split('T')[0];
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: `오늘 날짜는 ${today}입니다.
사용자가 미팅 관련 요구사항을 한국어로 말했습니다:
"${userText}"

다음 JSON 형식으로만 반환하세요 (다른 설명 없이):
{
  "dates": ["YYYY-MM-DD", ...],
  "roomName": "방 이름 (언급이 없으면 null)"
}`,
        }],
      });
      const rawText = response.content[0].text.trim();
      const cleaned = rawText.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      const dates = parsed.dates || [];
      const roomName = parsed.roomName || null;
      if (dates.length > 0) return res.json({ dates, roomName, source: 'claude' });
    } catch (err) {
      console.warn('Claude API 실패, JS 파서로 폴백:', err.message);
    }
  }

  // 2) JS 파서 폴백
  const dates = parseKoreanDates(userText);
  const roomName = parseRoomName(userText);
  if (dates.length > 0) return res.json({ dates, roomName, source: 'js-parser' });

  res.json({ dates: [], roomName: null, message: '날짜를 인식하지 못했어요.' });
});

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`서버 실행 중: http://localhost:${PORT}`);
  });
}

module.exports = app;
