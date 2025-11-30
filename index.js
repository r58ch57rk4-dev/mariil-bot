require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Telegraf, Markup, session } = require("telegraf");
const { z } = require("zod");
const { createClient } = require("@supabase/supabase-js");

const {
  BOT_TOKEN,
  ADMIN_CHAT_ID,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  WEBHOOK_SECRET,
  SITE_ORIGIN,
} = process.env;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!ADMIN_CHAT_ID) throw new Error("ADMIN_CHAT_ID missing");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL missing");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

const app = express();
app.use(cors({ origin: SITE_ORIGIN ? SITE_ORIGIN.split(",") : true }));
app.use(express.json());

// ====== UI / Texts ======
const segTitle = {
  specialist: "Специалист / Эксперт",
  business: "Бизнес",
  event: "Эвент",
  teambuilding: "Тимбилдинг",
};

const segKb = Markup.inlineKeyboard([
  [Markup.button.callback("👤 Специалист / Эксперт", "seg_specialist")],
  [Markup.button.callback("🏢 Бизнес", "seg_business")],
  [Markup.button.callback("🎤 Эвент", "seg_event")],
  [Markup.button.callback("🤝 Тимбилдинг", "seg_teambuilding")],
  [Markup.button.callback("📝 Бриф (1 мин)", "brief_start")],
]);

function clean(s) {
  return (s || "").toString().trim();
}

async function saveLeadFromBot(ctx, segment, data) {
  const u = ctx.from || {};
  const note = [
    `goal: ${data.goal || "-"}`,
    `deadline: ${data.deadline || "-"}`,
    `contact: ${data.contact || "-"}`,
  ].join("\n");

  const { data: lead, error } = await supabase
    .from("leads")
    .insert({
      source: "bot",
      segment,
      name: u.first_name || null,
      telegram_username: u.username ? `@${u.username}` : null,
      telegram_user_id: u.id,
      note,
    })
    .select()
    .single();

  if (!error && lead?.id) {
    await supabase.from("lead_events").insert({
      lead_id: lead.id,
      type: "bot_brief",
      payload: data,
    });
  }

  return { lead, error };
}

async function notifyMarina(source, segment, payload, leadId, tgUser) {
  const msg =
    `🧾 *ЗАЯВКА (${source})*\n` +
    `Сегмент: *${segTitle[segment] || segment}*\n` +
    (tgUser?.first_name ? `Имя: ${tgUser.first_name}\n` : "") +
    (tgUser?.username ? `Ник: @${tgUser.username}\n` : "") +
    (payload.goal ? `Задача: ${payload.goal}\n` : "") +
    (payload.deadline ? `Сроки: ${payload.deadline}\n` : "") +
    (payload.contact ? `Контакт: ${payload.contact}\n` : "") +
    (payload.name ? `Имя (сайт): ${payload.name}\n` : "") +
    (payload.phone ? `Тел: ${payload.phone}\n` : "") +
    (payload.email ? `Email: ${payload.email}\n` : "") +
    (payload.message ? `Сообщение: ${payload.message}\n` : "") +
    (leadId ? `ID: \`${leadId}\`` : "");

  await bot.telegram.sendMessage(ADMIN_CHAT_ID, msg, { parse_mode: "Markdown" });
}

// ====== BOT FLOW ======
bot.start(async (ctx) => {
  const payload = ctx.startPayload || "";
  const segFromPayload = payload.startsWith("seg_") ? payload.replace("seg_", "") : null;

  await ctx.reply(
    "Добро пожаловать в **Мари-Иль**.\nЯ — бот-менеджер агентства: задам несколько вопросов и передам заявку Марине лично.",
    { parse_mode: "Markdown" }
  );

  if (segFromPayload && segTitle[segFromPayload]) {
    ctx.session.segment = segFromPayload;
    await ctx.reply(`Вы выбрали: **${segTitle[segFromPayload]}**.`, { parse_mode: "Markdown" });
  }

  await ctx.reply("Выберите направление:", segKb);
});

bot.action(/seg_(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const segment = ctx.match[1];
  ctx.session.segment = segment;
  ctx.session.step = null;
  ctx.session.brief = {};

  await ctx.reply(
    `Принято: **${segTitle[segment] || segment}**.\nГотовы за 60 секунд собрать заявку?`,
    {
      parse_mode: "Markdown",
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("✅ Да, бриф", "brief_start")],
        [Markup.button.callback("↩️ Назад к выбору", "back_to_segments")],
      ]).reply_markup,
    }
  );
});

bot.action("back_to_segments", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.step = null;
  ctx.session.brief = {};
  await ctx.reply("Выберите направление:", segKb);
});

bot.action("brief_start", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.step = "goal";
  ctx.session.brief = {};
  await ctx.reply("1/3. Напишите одной фразой, что нужно (цель/задача):");
});

bot.on("text", async (ctx) => {
  if (!ctx.session?.step) return;

  const text = clean(ctx.message.text);
  ctx.session.brief = ctx.session.brief || {};

  if (ctx.session.step === "goal") {
    ctx.session.brief.goal = text;
    ctx.session.step = "deadline";
    return ctx.reply("2/3. Сроки: когда нужно получить результат?");
  }

  if (ctx.session.step === "deadline") {
    ctx.session.brief.deadline = text;
    ctx.session.step = "contact";
    return ctx.reply("3/3. Контакт: телефон или @ник (как удобнее)");
  }

  if (ctx.session.step === "contact") {
    ctx.session.brief.contact = text;
    ctx.session.step = null;

    const segment = ctx.session.segment || "specialist";
    const data = ctx.session.brief;
    const u = ctx.from || {};

    const { lead } = await saveLeadFromBot(ctx, segment, data);
    await notifyMarina("BOT", segment, data, lead?.id, u);

    return ctx.reply("Заявка принята ✅ Марина свяжется с вами лично.");
  }
});

// ====== API FOR SITE (form -> bot server) ======
const LeadSchema = z.object({
  segment: z.enum(["specialist", "business", "event", "teambuilding"]),
  name: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  message: z.string().optional(),
  utm_source: z.string().optional(),
  utm_medium: z.string().optional(),
  utm_campaign: z.string().optional(),
  hp: z.string().optional(), // honeypot
});

app.post("/api/lead", async (req, res) => {
  const parsed = LeadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false });

  // anti-spam honeypot
  if (parsed.data.hp && clean(parsed.data.hp).length > 0) return res.json({ ok: true });

  const p = parsed.data;

  const { data: lead, error } = await supabase
    .from("leads")
    .insert({
      source: "site",
      segment: p.segment,
      name: p.name || null,
      phone: p.phone || null,
      email: p.email || null,
      utm_source: p.utm_source || null,
      utm_medium: p.utm_medium || null,
      utm_campaign: p.utm_campaign || null,
      note: p.message || null,
    })
    .select()
    .single();

  await notifyMarina("SITE", p.segment, p, lead?.id, null);

  if (error) return res.status(500).json({ ok: false });
  return res.json({ ok: true, id: lead.id });
});

// ====== Telegram Webhook endpoint ======
app.post("/telegram/webhook", async (req, res) => {
  const headerSecret = req.get("X-Telegram-Bot-Api-Secret-Token");
  if (WEBHOOK_SECRET && headerSecret !== WEBHOOK_SECRET) return res.status(401).send("Unauthorized");
  await bot.handleUpdate(req.body, res);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("mariil-bot listening on", port));
