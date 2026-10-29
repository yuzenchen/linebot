import { bootstrap } from './bootstrap.js';

const json = process.argv.includes('--json');
const { db, repos } = bootstrap();
const stats = new Map(repos.messages.statsByUser().map((s) => [s.userId, s]));
const users = repos.users.list().map((u) => ({
  userId: u.user_id,
  followed: u.followed === 1,
  handoffUntil: u.handoff_until,
  lowConfStreak: u.low_conf_streak,
  lastMessageAt: stats.get(u.user_id)?.lastAt ?? null,
  messageCount: stats.get(u.user_id)?.count ?? 0,
}));
db.close();

if (json) {
  console.log(JSON.stringify(users, null, 2));
} else if (users.length === 0) {
  console.log('目前沒有使用者');
} else {
  const head = [
    'userId',
    'followed',
    'handoff_until',
    'low_conf_streak',
    'last message at',
    'messages count',
  ];
  const body = users.map((u) => [
    u.userId,
    u.followed ? 'yes' : 'no',
    u.handoffUntil ?? '-',
    String(u.lowConfStreak),
    u.lastMessageAt ?? '-',
    String(u.messageCount),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? '').length)));
  const fmt = (r: string[]) =>
    r
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  console.log(fmt(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of body) console.log(fmt(r));
  console.log(`共 ${users.length} 位使用者`);
}
