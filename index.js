require("dotenv").config();

const fs = require("fs");
const path = require("path");
const dns = require("dns");
const TelegramBot = require("node-telegram-bot-api");
const nodemailer = require("nodemailer");
const pdfParse = require("pdf-parse");

// Force IPv4 DNS resolution - fixes ENETUNREACH/ETIMEDOUT to Gmail SMTP on Render
dns.setDefaultResultOrder("ipv4first");
const {
  extractJobDetails,
  generateProfessionalMail,
  extractTextFromImage,
  generateCustomMail,
  generateWhatsappMessage
} = require("./openrouter");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: true,
});

const userJobs = new Map();
const userDrafts = new Map();

// Track what the bot is currently waiting for from the user
// e.g. "awaiting_pdf", "awaiting_image", "awaiting_email"
const userState = new Map();

// Make sure uploads folder exists
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ----------------------------------------------------------------
// Nodemailer transporter (Gmail SMTP, IPv4 forced via dns.setDefaultResultOrder)
// ----------------------------------------------------------------
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

console.log("🤖 Placement Agent Started");
const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("🚀 Placement Agent Running");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});

// ----------------------------------------------------------------
// Helper: download a Telegram file to local uploads folder
// ----------------------------------------------------------------
async function downloadTelegramFile(fileId, destFileName) {
  const fileLink = await bot.getFileLink(fileId);
  const destPath = path.join(UPLOAD_DIR, destFileName);

  const response = await fetch(fileLink);
  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(arrayBuffer));

  return destPath;
}

// ----------------------------------------------------------------
// Helper: extract plain text from a PDF file on disk
// ----------------------------------------------------------------
async function extractTextFromPdf(filePath) {
  try {
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    return data.text ? data.text.trim() : "";
  } catch (error) {
    console.error("PDF Parse Error:", error);
    return "";
  }
}

// ----------------------------------------------------------------
// Helper: run the full "analyze job notification" flow
// (extract job details, send summary + action buttons)
// ----------------------------------------------------------------
async function analyzeAndRespond(chatId, text) {
  const jobData = await extractJobDetails(text);

  userJobs.set(chatId, {
    jobData,
    originalText: text
  });

  const responseMessage = `
🏢 Company: ${jobData.company_name || "N/A"}

💼 Role: ${jobData.role || "N/A"}

💰 CTC: ${jobData.ctc || "N/A"}

📍 Location: ${jobData.location || "N/A"}

📅 Deadline: ${jobData.deadline || "N/A"}

📝 Summary:
${jobData.summary || "No summary available"}
`;

  await bot.sendMessage(chatId, responseMessage, {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "📧 Create Mail",
            callback_data: "create_mail",
          },
          {
            text: "📱 Create WhatsApp",
            callback_data: "create_whatsapp",
          },
        ],
        [
          {
            text: "📄 Create Notice",
            callback_data: "create_notice",
          },
          {
            text: "🚀 Publish",
            callback_data: "publish",
          },
        ],
      ],
    },
  });
}

// ----------------------------------------------------------------
// Helper: wrap plain text mail body into a professional HTML template
// ----------------------------------------------------------------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ----------------------------------------------------------------
// Helper: strip leading preamble labels the AI sometimes adds,
// e.g. "**Email Body:**", "Email Body:", "Here's the email:", etc.
// ----------------------------------------------------------------
function stripAiPreamble(text) {
  const lines = text.split("\n");
  let startIndex = 0;

  const preamblePatterns = [
    /^\s*\*{0,2}email\s*body\s*:?\s*\*{0,2}\s*$/i,
    /^\s*\*{0,2}here'?s?\s+(the|your)\s+email.*\*{0,2}\s*:?\s*$/i,
    /^\s*\*{0,2}email\s+content\s*:?\s*\*{0,2}\s*$/i,
    /^\s*\*{0,2}draft\s*:?\s*\*{0,2}\s*$/i,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line === "" || /^\*+$/.test(line)) {
      startIndex = i + 1;
      continue;
    }

    if (preamblePatterns.some((re) => re.test(line))) {
      startIndex = i + 1;
      continue;
    }

    break;
  }

  return lines.slice(startIndex).join("\n").trim();
}

// ----------------------------------------------------------------
// Helper: remove AI-generated sign-off / signature block from the
// mail body, since the template adds its own signature & footer.
// ----------------------------------------------------------------
function stripAiSignature(text) {
  const lines = text.split("\n");

  // Patterns that indicate the start of a sign-off block
  const signOffPatterns = [
    /^\s*(warm regards|best regards|regards|sincerely|thanks\s*&\s*regards|thanking you)\s*,?\s*$/i,
    /^\s*\*{0,2}ayush shukla\*{0,2}\s*$/i,
    /^\s*placement coordinator\s*$/i,
    /^\s*cpdd[, ]*gcet.*$/i,
    /^\s*---+\s*$/,
    /^\s*\*{0,2}note:?\*{0,2}.*official notification.*$/i,
    /^\s*email:\s*\[.*\]\s*$/i,
    /^\s*phone:\s*\[.*\]\s*$/i,
  ];

  let cutIndex = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (signOffPatterns.some((re) => re.test(line))) {
      cutIndex = i;
      break;
    }
  }

  return lines.slice(0, cutIndex).join("\n").trim();
}

// ----------------------------------------------------------------
// Helper: convert simple Markdown (used by the AI mail generator)
// into safe HTML for email rendering.
// Supports: **bold**, ### headings, - bullet lists, --- rules,
// and paragraphs/line breaks.
// ----------------------------------------------------------------
function markdownToHtml(text) {
  const preprocessed = text
    .split("\n")
    .map((rawLine) => {
      const line = rawLine.trim();

      const labelWithBullets = line.match(/^(\*{0,2}[^:*\n]+:\*{0,2})\s+-\s+(.+)$/);
      if (labelWithBullets) {
        const label = labelWithBullets[1].trim();
        const rest = labelWithBullets[2].trim();
        const restParts = rest.split(/\s+-\s+/).map((p) => p.trim()).filter(Boolean);

        if (restParts.length > 1) {
          return [label, ...restParts.map((p) => `- ${p}`)].join("\n");
        } else if (restParts.length === 1) {
          return `${label} ${restParts[0]}`;
        }
      }

      if (/^[-*•]\s+/.test(line) && (line.match(/\s[-•]\s/g) || []).length >= 1) {
        const firstDashRemoved = line.replace(/^[-*•]\s+/, "");
        const parts = firstDashRemoved.split(/\s+[-•]\s+/).map((p) => p.trim()).filter(Boolean);
        if (parts.length > 1) {
          return parts.map((part) => `- ${part}`).join("\n");
        }
      }

      return rawLine;
    })
    .join("\n");

  const lines = preprocessed.split("\n");
  const htmlParts = [];

  let inList = false;

  const closeList = () => {
    if (inList) {
      htmlParts.push("</ul>");
      inList = false;
    }
  };

  const inlineFormat = (line) => {
    let escaped = escapeHtml(line);
    escaped = escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    escaped = escaped.replace(/(^|[^*])\*(?!\*)([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
    return escaped;
  };

  const formatBulletLine = (content) => {
    const labelValueMatch = content.match(/^([^:]{1,40}):\s*(.+)$/);
    if (labelValueMatch) {
      const label = inlineFormat(labelValueMatch[1].trim());
      const value = inlineFormat(labelValueMatch[2].trim());
      return `<span style="color:#64748b;">${label}:</span> <span style="font-weight:700;color:#0f172a;background:#fef3c7;padding:1px 6px;border-radius:4px;">${value}</span>`;
    }
    return inlineFormat(content);
  };

  const sectionPalette = [
    { border: "#dc2626", bg: "#fef2f2", text: "#991b1b" },
  ];
  let sectionIndex = 0;

  let inSectionCard = false;

  const closeSectionCard = () => {
    if (inSectionCard) {
      htmlParts.push("</td></tr></table>");
      inSectionCard = false;
    }
  };

  const openSectionCard = (titleHtml) => {
    const palette = sectionPalette[sectionIndex % sectionPalette.length];
    sectionIndex++;
    htmlParts.push(
      `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px 0;background:${palette.bg};border-radius:8px;border-left:4px solid ${palette.border};">` +
        `<tr><td style="padding:14px 16px;">` +
        `<p style="margin:0 0 8px 0;font-size:14px;font-weight:700;color:${palette.text};text-transform:uppercase;letter-spacing:0.5px;">${titleHtml}</p>`
    );
    inSectionCard = true;
  };

  for (let rawLine of lines) {
    const line = rawLine.trim();

    if (/^\*+$/.test(line)) {
      continue;
    }

    if (/^-{3,}$/.test(line)) {
      closeList();
      closeSectionCard();
      htmlParts.push('<hr style="border:none;border-top:1px solid #e5e7eb;margin:18px 0;" />');
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      closeList();
      closeSectionCard();
      const headingText = headingMatch[2].replace(/\*\*/g, "").trim();
      openSectionCard(inlineFormat(headingText));
      continue;
    }

    const boldLabelMatch = line.match(/^\*\*([^*]+:)\*\*$/);
    if (boldLabelMatch) {
      closeList();
      closeSectionCard();
      openSectionCard(inlineFormat(boldLabelMatch[1].trim().replace(/:$/, "")));
      continue;
    }

    const plainLabelMatch = line.match(/^([A-Za-z][A-Za-z0-9\s&/'-]{1,48}):$/);
    if (
      plainLabelMatch &&
      !/^(dear|hi|hello|regards|sincerely)\b/i.test(plainLabelMatch[1]) &&
      !/[.!?]/.test(plainLabelMatch[1])
    ) {
      closeList();
      closeSectionCard();
      openSectionCard(inlineFormat(plainLabelMatch[1].trim()));
      continue;
    }

    const bulletMatch = line.match(/^[-*•]\s+(.*)$/);
    if (bulletMatch) {
      if (!inList) {
        htmlParts.push('<ul style="margin:0 0 8px 0;padding-left:20px;">');
        inList = true;
      }
      htmlParts.push(`<li style="margin-bottom:6px;line-height:1.5;">${formatBulletLine(bulletMatch[1])}</li>`);
      continue;
    }

    const numberedMatch = line.match(/^\d+\.\s+(.*)$/);
    if (numberedMatch) {
      if (!inList) {
        htmlParts.push('<ul style="margin:0 0 8px 0;padding-left:20px;">');
        inList = true;
      }
      htmlParts.push(`<li style="margin-bottom:6px;line-height:1.5;">${inlineFormat(numberedMatch[1])}</li>`);
      continue;
    }

    closeList();

    if (line === "") {
      closeList();
      closeSectionCard();
      continue;
    }

    const inlineLabelValueMatch = line.match(/^([A-Za-z][A-Za-z0-9\s&/'-]{1,40}):\s+(.+)$/);
    if (inlineLabelValueMatch && !/[.!?]/.test(inlineLabelValueMatch[1])) {
      const wrapStyle = inSectionCard
        ? 'style="margin:0 0 6px 0;line-height:1.5;"'
        : 'style="margin:0 0 14px 0;"';
      htmlParts.push(`<p ${wrapStyle}>${formatBulletLine(line)}</p>`);
      continue;
    }

    if (inSectionCard) {
      htmlParts.push(`<p style="margin:0 0 6px 0;line-height:1.5;">${inlineFormat(line)}</p>`);
    } else {
      htmlParts.push(`<p style="margin:0 0 14px 0;">${inlineFormat(line)}</p>`);
    }
  }

  closeList();
  closeSectionCard();
  return htmlParts.join("\n");
}

function buildEmailTemplate(subject, bodyText, jobData) {
  const noPreamble = stripAiPreamble(bodyText);

  const cleanedBody = stripAiSignature(noPreamble);

  const escapedBody = markdownToHtml(cleanedBody);

  const company = jobData && jobData.company_name ? escapeHtml(jobData.company_name) : "";
  const role = jobData && jobData.role ? escapeHtml(jobData.role) : "";
  const ctc = jobData && (jobData.ctc || jobData.ppo_package) ? escapeHtml(jobData.ctc || jobData.ppo_package) : "";
  const deadline = jobData && jobData.deadline ? escapeHtml(jobData.deadline) : "";
  const location = jobData && jobData.location ? escapeHtml(jobData.location) : "";
  const batch = jobData && jobData.batch ? escapeHtml(jobData.batch) : "";
  const applicationLink = jobData && jobData.application_link ? jobData.application_link.trim() : "";

  const LOGO_URL = "https://raw.githubusercontent.com/ayush112-gif/cpdd-assets/main/Screenshot_2026-06-14_215901-removebg-preview.png";

  const chips = [];
  if (company) chips.push({ label: "Company", value: company, bg: "#eef2ff", fg: "#3730a3" });
  if (role) chips.push({ label: "Role", value: role, bg: "#f0fdf4", fg: "#166534" });
  if (ctc) chips.push({ label: "CTC", value: ctc, bg: "#fff7ed", fg: "#9a3412" });
  if (deadline) chips.push({ label: "Deadline", value: deadline, bg: "#fef2f2", fg: "#991b1b" });
  if (location) chips.push({ label: "Location", value: location, bg: "#f5f3ff", fg: "#5b21b6" });
  if (batch) chips.push({ label: "Batch", value: batch, bg: "#ecfeff", fg: "#0e7490" });

  const chipCells = chips
    .map(
      (chip) => `
        <div class="chip" style="display:inline-block;vertical-align:top;background:${chip.bg};border-radius:8px;padding:8px 14px;margin:0 8px 8px 0;">
          <p style="margin:0;font-size:10px;letter-spacing:0.5px;text-transform:uppercase;color:${chip.fg};opacity:0.75;font-weight:600;">${chip.label}</p>
          <p style="margin:2px 0 0 0;font-size:13px;font-weight:700;color:${chip.fg};">${chip.value}</p>
        </div>`
    )
    .join("");

  const chipsBlock = chips.length
    ? `<tr>
        <td class="content-pad" style="padding:0 28px 8px 28px;">
          ${chipCells}
        </td>
      </tr>`
    : "";

  const ctaBlock = applicationLink
    ? `<tr>
        <td class="content-pad" style="padding:6px 28px 22px 28px;" align="left">
          <a href="${escapeHtml(applicationLink)}" target="_blank" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 28px;border-radius:6px;">Apply Now &rarr;</a>
        </td>
      </tr>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="format-detection" content="telephone=no" />
    <title>${escapeHtml(subject)}</title>
    <style>
      body, table, td, p, a, h1, h2 { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
      table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
      img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }
      a { color: #2563eb; }

      @media only screen and (max-width: 600px) {
        .email-wrapper { width: 100% !important; border-radius: 0 !important; }
        .content-pad { padding-left: 18px !important; padding-right: 18px !important; }
        .header-pad { padding-left: 18px !important; padding-right: 18px !important; }
        .title-text { font-size: 19px !important; }
        .logo-img { width: 160px !important; }
        .chip { display: block !important; width: 100% !important; margin: 0 0 8px 0 !important; box-sizing: border-box; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background-color:#eef1f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eef1f5;">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table role="presentation" class="email-wrapper" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(15,23,42,0.08);">

            <!-- College Logo Banner -->
            <tr>
              <td align="center" class="header-pad" style="background-color:#ffffff;padding:22px 28px 16px 28px;border-bottom:3px solid #1e3a8a;">
                <img src="${LOGO_URL}" alt="CPDD - Career Planning & Development Division, GCET" width="200" class="logo-img" style="display:block;max-width:200px;height:auto;" />
              </td>
            </tr>

            <!-- Title Bar -->
            <tr>
              <td class="header-pad" style="background:linear-gradient(120deg,#dc2626 0%,#f59e0b 50%,#2563eb 100%);padding:20px 28px;">
                <p style="margin:0;color:#fff7ed;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;text-shadow:0 1px 2px rgba(0,0,0,0.25);">Career Planning &amp; Development Division (CPDD)</p>
                <h1 class="title-text" style="margin:6px 0 0 0;color:#ffffff;font-size:20px;font-weight:700;line-height:1.35;text-shadow:0 1px 3px rgba(0,0,0,0.3);">${escapeHtml(subject)}</h1>
              </td>
            </tr>

            <!-- Chips spacer -->
            <tr>
              <td style="padding-top:18px;"></td>
            </tr>

            ${chipsBlock}

            ${ctaBlock}

            <!-- Body -->
            <tr>
              <td class="content-pad" style="padding:6px 28px 8px 28px;color:#1f2937;font-size:15px;line-height:1.65;">
                ${escapedBody}
              </td>
            </tr>

            <!-- Divider -->
            <tr>
              <td class="content-pad" style="padding:8px 28px;">
                <hr style="border:none;border-top:1px solid #e5e7eb;margin:0;" />
              </td>
            </tr>

            <!-- Signature -->
            <tr>
              <td class="content-pad" style="padding:20px 28px 24px 28px;">
                <table cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="width:4px;background-color:#2563eb;border-radius:2px;"></td>
                    <td style="padding-left:14px;">
                      <p style="margin:0 0 3px 0;font-size:14px;font-weight:700;color:#1e3a8a;">Ayush Shukla</p>
                      <p style="margin:0 0 2px 0;font-size:13px;color:#4b5563;">Placement Coordinator</p>
                      <p style="margin:0;font-size:13px;color:#4b5563;">CPDD &bull; Galgotias College of Engineering &amp; Technology (GCET) &bull; 2027 Batch</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Bottom bar -->
            <tr>
              <td class="content-pad" style="background-color:#f8fafc;padding:16px 28px;text-align:center;border-top:1px solid #e5e7eb;">
                <p style="margin:0;font-size:11px;color:#94a3b8;line-height:1.5;">This is an automated placement notification from the GCET Placement Cell &mdash; Career Planning &amp; Development Division.</p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// ----------------------------------------------------------------
// Helper: send the final mail using Resend
// ----------------------------------------------------------------
async function sendMailWithDraft(chatId, toEmail) {
  const draft = userDrafts.get(chatId);
  const savedJob = userJobs.get(chatId);
  const jobData = savedJob ? savedJob.jobData : {};

  if (!draft || !draft.emailDraft) {
    await bot.sendMessage(chatId, "❌ No mail draft found. Please create a mail first.");
    return;
  }

  // Split AI-generated draft into subject + body
  let subject;
  let body = draft.emailDraft;

  const subjectMatch = draft.emailDraft.match(/subject\s*:\s*(.+)/i);
  if (subjectMatch) {
    subject = subjectMatch[1].trim();
    body = draft.emailDraft.replace(subjectMatch[0], "").trim();
  } else if (jobData && (jobData.company_name || jobData.role)) {
    const companyPart = jobData.company_name ? jobData.company_name : "";
    const rolePart = jobData.role ? jobData.role : "";
    subject = `[Placement Opportunity] ${companyPart}${companyPart && rolePart ? " - " : ""}${rolePart}`.trim();
  } else {
    const firstLine = (body.split("\n").find((l) => l.trim().length > 0) || "").trim();
    if (firstLine && !/^dear\b/i.test(firstLine)) {
      subject = firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
    } else {
      subject = "Important Notification";
    }
  }

  // Strip markdown formatting (**, ##, etc.) from the subject line
  subject = subject
    .replace(/\*\*/g, "")
    .replace(/^#+\s*/, "")
    .replace(/[*_`]/g, "")
    .trim();

  const htmlBody = buildEmailTemplate(subject, body, jobData);

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: toEmail,
    subject: subject,
    text: body,
    html: htmlBody,
    attachments: [],
  };

  if (draft.attachmentPaths && draft.attachmentPaths.length > 0) {
    for (const p of draft.attachmentPaths) {
      mailOptions.attachments.push({
        filename: path.basename(p),
        path: p,
      });
    }
  }

  await transporter.sendMail(mailOptions);

  await bot.sendMessage(chatId, `✅ Mail sent successfully to ${toEmail}`);
}

// ----------------------------------------------------------------
// Helper: show "Send Mail" prompt after attachment step
// ----------------------------------------------------------------
async function showSendMailPrompt(chatId, attachmentPaths) {
  const list = attachmentPaths && attachmentPaths.length > 0
    ? attachmentPaths.map((p) => `• ${path.basename(p)}`).join("\n")
    : "None";

  await bot.sendMessage(
    chatId,
    `✅ Mail Ready

📎 Attachments:
${list}

You can add more attachments or send the mail now.`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "➕ Add More",
              callback_data: "add_more_attachment",
            },
          ],
          [
            {
              text: "🚀 Send Mail",
              callback_data: "send_mail",
            },
          ],
        ],
      },
    }
  );
}

// ----------------------------------------------------------------
// /start command - show mode selection
// ----------------------------------------------------------------
bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;

  await bot.sendMessage(
    chatId,
    `👋 Welcome to the Placement Communication Agent!

Choose what you'd like to do:`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📋 Analyze Placement Notification",
              callback_data: "mode_analyze_notification",
            },
          ],
          [
            {
              text: "✍️ Write Custom Mail (AI Assist)",
              callback_data: "mode_custom_mail",
            },
          ],
        ],
      },
    }
  );
});

// ----------------------------------------------------------------
// Message handler
// ----------------------------------------------------------------
bot.on("message", async (msg) => {
  try {
    const chatId = msg.chat.id;
    const text = msg.text || "";

    const state = userState.get(chatId);

    // -------- Handle PDF upload --------
    if (state === "awaiting_pdf") {
      if (msg.document && msg.document.mime_type === "application/pdf") {
        await bot.sendMessage(chatId, "📥 Downloading PDF...");

        const fileName = `pdf_${chatId}_${Date.now()}.pdf`;
        const filePath = await downloadTelegramFile(msg.document.file_id, fileName);

        const draft = userDrafts.get(chatId) || {};
        draft.attachmentPaths = draft.attachmentPaths || [];
        draft.attachmentPaths.push(filePath);
        userDrafts.set(chatId, draft);

        userState.delete(chatId);

        await bot.sendMessage(chatId, "✅ PDF attached to mail.");
        await showSendMailPrompt(chatId, draft.attachmentPaths);
      } else {
        await bot.sendMessage(chatId, "❌ Please send a valid PDF file.");
      }
      return;
    }

    // -------- Handle Image upload --------
    if (state === "awaiting_image") {
      if (msg.photo && msg.photo.length > 0) {
        await bot.sendMessage(chatId, "📥 Downloading Image...");

        const photo = msg.photo[msg.photo.length - 1];
        const fileName = `image_${chatId}_${Date.now()}.jpg`;
        const filePath = await downloadTelegramFile(photo.file_id, fileName);

        const draft = userDrafts.get(chatId) || {};
        draft.attachmentPaths = draft.attachmentPaths || [];
        draft.attachmentPaths.push(filePath);
        userDrafts.set(chatId, draft);

        userState.delete(chatId);

        await bot.sendMessage(chatId, "✅ Image attached to mail.");
        await showSendMailPrompt(chatId, draft.attachmentPaths);
      } else if (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith("image/")) {
        await bot.sendMessage(chatId, "📥 Downloading Image...");

        const ext = path.extname(msg.document.file_name || ".jpg");
        const fileName = `image_${chatId}_${Date.now()}${ext}`;
        const filePath = await downloadTelegramFile(msg.document.file_id, fileName);

        const draft = userDrafts.get(chatId) || {};
        draft.attachmentPaths = draft.attachmentPaths || [];
        draft.attachmentPaths.push(filePath);
        userDrafts.set(chatId, draft);

        userState.delete(chatId);

        await bot.sendMessage(chatId, "✅ Image attached to mail.");
        await showSendMailPrompt(chatId, draft.attachmentPaths);
      } else {
        await bot.sendMessage(chatId, "❌ Please send a valid image.");
      }
      return;
    }

    // -------- Handle email address input for Send Mail --------
    if (state === "awaiting_email") {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      if (emailRegex.test(text.trim())) {
        userState.delete(chatId);

        await bot.sendMessage(chatId, `📤 Sending mail to ${text.trim()}...`);

        try {
          await sendMailWithDraft(chatId, text.trim());
        } catch (err) {
          console.error("Mail send error:", err);
          await bot.sendMessage(chatId, "❌ Failed to send mail. Please check email settings.");
        }
      } else {
        await bot.sendMessage(chatId, "❌ Invalid email address. Please enter a valid email or Google Group address.");
      }
      return;
    }

    // -------- Handle custom mail instruction (AI Assist) --------
    if (state === "awaiting_custom_mail") {
      if (!text) {
        await bot.sendMessage(chatId, "❌ Please send your instruction as text.");
        return;
      }

      userState.delete(chatId);

      await bot.sendMessage(chatId, "✍️ Writing your mail...");

      try {
        const emailDraft = await generateCustomMail(text);

        userDrafts.set(chatId, { emailDraft });

        userJobs.set(chatId, { jobData: {}, originalText: text });

        await bot.sendMessage(chatId, emailDraft, {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "📨 Insert Mail",
                  callback_data: "insert_mail",
                },
                {
                  text: "✏️ Regenerate",
                  callback_data: "regenerate_custom_mail",
                },
              ],
            ],
          },
        });
      } catch (err) {
        console.error("Custom mail generation error:", err);
        await bot.sendMessage(chatId, "❌ Failed to generate the mail. Please try again.");
      }

      return;
    }

    // -------- Direct PDF analysis (no attachment flow active) --------
    if (msg.document && msg.document.mime_type === "application/pdf") {
      await bot.sendMessage(chatId, "📥 Reading PDF...");

      const fileName = `notif_pdf_${chatId}_${Date.now()}.pdf`;
      const filePath = await downloadTelegramFile(msg.document.file_id, fileName);

      const pdfText = await extractTextFromPdf(filePath);

      if (!pdfText) {
        await bot.sendMessage(
          chatId,
          "❌ Could not extract any text from this PDF. It may be a scanned/image-based PDF. Try sending it as an image instead, or paste the details as text."
        );
        return;
      }

      await bot.sendMessage(chatId, "🔍 Analyzing Job Post from PDF...");

      console.log("\n📄 PDF Extracted Text:");
      console.log(pdfText);

      await analyzeAndRespond(chatId, pdfText);
      return;
    }

    // -------- Direct Image analysis (no attachment flow active) --------
    if (
      (msg.photo && msg.photo.length > 0) ||
      (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith("image/"))
    ) {
      await bot.sendMessage(chatId, "📥 Reading Image...");

      let fileId;
      let ext = ".jpg";

      if (msg.photo && msg.photo.length > 0) {
        const photo = msg.photo[msg.photo.length - 1];
        fileId = photo.file_id;
      } else {
        fileId = msg.document.file_id;
        ext = path.extname(msg.document.file_name || ".jpg");
      }

      const fileName = `notif_image_${chatId}_${Date.now()}${ext}`;
      const filePath = await downloadTelegramFile(fileId, fileName);

      const imageBuffer = fs.readFileSync(filePath);
      const base64Image = imageBuffer.toString("base64");

      let mimeType = "image/jpeg";
      if (ext.toLowerCase() === ".png") mimeType = "image/png";
      else if (ext.toLowerCase() === ".webp") mimeType = "image/webp";

      await bot.sendMessage(chatId, "🔍 Analyzing Image with AI...");

      const imageText = await extractTextFromImage(base64Image, mimeType);

      if (!imageText) {
        await bot.sendMessage(
          chatId,
          "❌ Could not extract any information from this image. Please try a clearer image or paste the details as text."
        );
        return;
      }

      console.log("\n🖼 Image Extracted Text:");
      console.log(imageText);

      await analyzeAndRespond(chatId, imageText);
      return;
    }

    // -------- Default: treat as job notification text --------
    if (!text) {
      return;
    }

    console.log("\n📩 New Message:");
    console.log(text);

    await bot.sendMessage(
      chatId,
      "🔍 Analyzing Job Post..."
    );

    await analyzeAndRespond(chatId, text);
  } catch (error) {
    console.error(error);

    await bot.sendMessage(
      msg.chat.id,
      "❌ Failed to analyze message."
    );
  }
});

// ----------------------------------------------------------------
// Callback query handler
// ----------------------------------------------------------------
bot.on("callback_query", async (query) => {
  try {
    const chatId = query.message.chat.id;
    const action = query.data;

    const savedData = userJobs.get(chatId);

const jobData = savedData ? savedData.jobData : null;
const originalText = savedData ? savedData.originalText : null;

    const noJobDataNeeded = [
      "send_mail",
      "mode_analyze_notification",
      "mode_custom_mail",
      "regenerate_custom_mail",
    ];

    if (!jobData && !noJobDataNeeded.includes(action)) {
      return bot.sendMessage(
        chatId,
        "❌ No analyzed opportunity found."
      );
    }

    if (action === "create_mail") {

  await bot.sendMessage(
    chatId,
    "📧 Generating professional placement email..."
  );

  const emailDraft = await generateProfessionalMail(
  originalText,
  jobData
);

userDrafts.set(chatId, {
  emailDraft
});

await bot.sendMessage(chatId, emailDraft, {
  reply_markup: {
    inline_keyboard: [
      [
        {
          text: "📨 Insert Mail",
          callback_data: "insert_mail"
        },
        {
          text: "✏️ Regenerate",
          callback_data: "regenerate_mail"
        }
      ]
    ]
  }
});
}

    if (action === "create_whatsapp") {
      await bot.sendMessage(chatId, "📱 Generating WhatsApp message...");

      try {
        const whatsappMessage = await generateWhatsappMessage(originalText, jobData);

        const draft = userDrafts.get(chatId) || {};
        draft.whatsappDraft = whatsappMessage;
        userDrafts.set(chatId, draft);

        await bot.sendMessage(chatId, whatsappMessage, {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "📲 Insert WhatsApp",
                  callback_data: "insert_whatsapp",
                },
                {
                  text: "✏️ Regenerate",
                  callback_data: "regenerate_whatsapp",
                },
              ],
            ],
          },
        });
      } catch (err) {
        console.error("WhatsApp generation error:", err);
        await bot.sendMessage(chatId, "❌ Failed to generate WhatsApp message. Please try again.");
      }
    }

    if (action === "regenerate_whatsapp") {
      await bot.sendMessage(chatId, "✏️ Regenerating WhatsApp message...");

      try {
        const whatsappMessage = await generateWhatsappMessage(originalText, jobData);

        const draft = userDrafts.get(chatId) || {};
        draft.whatsappDraft = whatsappMessage;
        userDrafts.set(chatId, draft);

        await bot.sendMessage(chatId, whatsappMessage, {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "📲 Insert WhatsApp",
                  callback_data: "insert_whatsapp",
                },
                {
                  text: "✏️ Regenerate",
                  callback_data: "regenerate_whatsapp",
                },
              ],
            ],
          },
        });
      } catch (err) {
        console.error("WhatsApp regeneration error:", err);
        await bot.sendMessage(chatId, "❌ Failed to regenerate WhatsApp message. Please try again.");
      }
    }

    if (action === "insert_whatsapp") {
      const draft = userDrafts.get(chatId);

      if (!draft || !draft.whatsappDraft) {
        await bot.sendMessage(chatId, "❌ No WhatsApp message found. Please create one first.");
      } else {
        let messageText = draft.whatsappDraft;

        const MAX_WA_LENGTH = 1500;
        if (messageText.length > MAX_WA_LENGTH) {
          messageText = messageText.slice(0, MAX_WA_LENGTH - 3) + "...";
        }

        const encodedMessage = encodeURIComponent(messageText);
        const waLink = `https://wa.me/?text=${encodedMessage}`;

        await bot.sendMessage(
          chatId,
          "📲 Message ready! Tap below to open WhatsApp and share it to your group/contact:",
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "📤 Send to WhatsApp Group",
                    url: waLink,
                  },
                ],
              ],
            },
          }
        );
      }
    }

    if (action === "create_notice") {
      await bot.sendMessage(
        chatId,
        `📄 NOTICE

Company: ${jobData.company_name}

Role: ${jobData.role}

CTC: ${jobData.ctc || "N/A"}

Location: ${jobData.location || "N/A"}

Deadline:
${jobData.deadline || "N/A"}`
      );
    }

    if (action === "publish") {
      await bot.sendMessage(
        chatId,
        `🚀 Publish Module

Coming Soon:

✅ Send Mail
✅ Send WhatsApp
✅ Send PDF`
      );
    }

    // -------- Mode: Analyze Placement Notification --------
    if (action === "mode_analyze_notification") {
      await bot.sendMessage(
        chatId,
        "📋 Send me the placement notification — as text, a PDF, or an image — and I'll analyze it."
      );
    }

    // -------- Mode: Custom Mail (AI Assist) --------
    if (action === "mode_custom_mail") {
      userState.set(chatId, "awaiting_custom_mail");
      await bot.sendMessage(
        chatId,
        `✍️ Tell me what mail you want to send.

For example: "I need to inform my classmates that tomorrow's class is rescheduled to 4 PM" or "Write a mail to invite everyone for a coding workshop on Saturday at 10 AM in Lab 3".

I'll write a professional mail for you, then you can attach a PDF/image and send it.`
      );
    }

    // -------- Regenerate custom mail --------
    if (action === "regenerate_custom_mail") {
      const savedJob = userJobs.get(chatId);
      const originalInstruction = savedJob ? savedJob.originalText : null;

      if (!originalInstruction) {
        await bot.sendMessage(chatId, "❌ Nothing to regenerate. Please start again with ✍️ Write Custom Mail.");
      } else {
        await bot.sendMessage(chatId, "✍️ Regenerating your mail...");

        try {
          const emailDraft = await generateCustomMail(originalInstruction);

          userDrafts.set(chatId, { emailDraft });

          await bot.sendMessage(chatId, emailDraft, {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "📨 Insert Mail",
                    callback_data: "insert_mail",
                  },
                  {
                    text: "✏️ Regenerate",
                    callback_data: "regenerate_custom_mail",
                  },
                ],
              ],
            },
          });
        } catch (err) {
          console.error("Custom mail regeneration error:", err);
          await bot.sendMessage(chatId, "❌ Failed to regenerate the mail. Please try again.");
        }
      }
    }

    
    if (action === "insert_mail") {

  await bot.sendMessage(
    chatId,
    "📨 Mail inserted successfully.\n\n📎 Select attachment option:",
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📎 Add PDF",
              callback_data: "add_pdf"
            },
            {
              text: "🖼 Add Image",
              callback_data: "add_image"
            }
          ],
          [
            {
              text: "⏭ No Attachment",
              callback_data: "no_attachment"
            }
          ]
        ]
      }
    }
  );

}

    // -------- Add PDF --------
    if (action === "add_pdf") {
      userState.set(chatId, "awaiting_pdf");
      await bot.sendMessage(chatId, "📎 Please send the PDF file you want to attach.");
    }

    // -------- Add Image --------
    if (action === "add_image") {
      userState.set(chatId, "awaiting_image");
      await bot.sendMessage(chatId, "🖼 Please send the image you want to attach.");
    }

    // -------- No Attachment --------
    if (action === "no_attachment") {
      const draft = userDrafts.get(chatId) || {};
      draft.attachmentPaths = [];
      userDrafts.set(chatId, draft);

      await showSendMailPrompt(chatId, []);
    }

    // -------- Add More Attachments --------
    if (action === "add_more_attachment") {
      await bot.sendMessage(
        chatId,
        "📎 Select what you'd like to add:",
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "📎 Add PDF",
                  callback_data: "add_pdf",
                },
                {
                  text: "🖼 Add Image",
                  callback_data: "add_image",
                },
              ],
            ],
          },
        }
      );
    }

    // -------- Send Mail --------
    if (action === "send_mail") {
      userState.set(chatId, "awaiting_email");
      await bot.sendMessage(
        chatId,
        "📧 Please enter the recipient email address (Gmail / Google Group):"
      );
    }

    await bot.answerCallbackQuery(query.id);
  } catch (error) {
    console.error(error);
  }
});