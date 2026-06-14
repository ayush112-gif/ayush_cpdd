const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

async function extractJobDetails(text) {
  try {
    const response = await client.chat.completions.create({
      model: "deepseek/deepseek-chat-v3",
      temperature: 0,
      max_tokens: 1200,

      messages: [
        {
          role: "system",
          content: `
You are an expert placement and recruitment analyst.

Extract information from the given job notification.

Return ONLY valid JSON.

Schema:

{
  "company_name": "",
  "role": "",
  "job_type": "",
  "batch": "",
  "location": "",
  "work_mode": "",
  "work_location_address": "",
  "ctc": "",
  "base_salary": "",
  "joining_bonus": "",
  "retention_bonus": "",
  "stock_options": "",
  "internship_stipend": "",
  "internship_duration": "",
  "ppo_package": "",
  "salary_breakdown": [],
  "bond_details": "",
  "eligibility": "",
  "branches": [],
  "eligible_courses": [],
  "minimum_cgpa": "",
  "skills_required": [],
  "selection_process": [],
  "assessment_details": "",
  "programming_languages": [],
  "job_description": "",
  "application_link": "",
  "deadline": "",
  "deadline_time": "",
  "test_date": "",
  "interview_date": "",
  "joining_date": "",
  "contact_email": "",
  "contact_person": "",
  "contact_phone": "",
  "important_instructions": [],
  "summary": ""
}

Field Guidance:
- "batch": the eligible pass-out batch/year (e.g. "2026", "2027").
- "work_location_address": the specific office address mentioned for work/internship (e.g. "Plot No. 861, Udyog Vihar, Phase 5, Gurugram, Haryana"), if different from general "location".
- "internship_duration": e.g. "12 months", "6 months", if this role involves an internship.
- "ppo_package": the post-internship full-time CTC/package if mentioned (e.g. "12.7 LPA"), even if different from "ctc".
- "salary_breakdown": an array of strings, each describing one salary/compensation component with its amount, e.g. ["Fixed: 8,80,000", "FY Bonus: 70,400", "SY Bonus: 1,92,000", "Total CTC: 12,70,400"]. Capture all numeric breakdowns mentioned for stipend, CTC, bonuses, etc.
- "eligible_courses": array of eligible degree/course combinations exactly as mentioned, e.g. ["B.Tech (CS/IT/ECE)", "MCA", "M.Tech (CS/IT)", "MSc (CS/IT)"].
- "assessment_details": describe how the selection assessment will be conducted (e.g. "Online assessment from college campus computer labs with webcams and mics enabled").
- "programming_languages": array of programming languages mentioned for assessment/role, e.g. ["Java", "Python", "JavaScript"].
- "deadline_time": the specific time mentioned for the registration deadline, if any (e.g. "11:00 PM", "09:00 AM sharp"). Keep "deadline" as just the date.
- "contact_phone": phone number(s) of the contact person, as a single string (comma-separated if multiple).

Rules:
1. Return only JSON.
2. No markdown.
3. No explanation.
4. Use empty string if data missing.
5. Use [] for missing arrays.
6. Never hallucinate.
7. Capture as much detail as possible; do not skip information just because it doesn't fit neatly into one field — use the closest matching field or include it in "summary" / "important_instructions".
`
        },
        {
          role: "user",
          content: text
        }
      ]
    });

    let content = response.choices[0].message.content.trim();

    content = content
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    return JSON.parse(content);

  } catch (error) {
    console.error("OpenRouter Error:", error);

    return {
      company_name: "",
      role: "",
      ctc: "",
      deadline: "",
      summary: "Failed to extract information"
    };
  }
}

async function generateProfessionalMail(originalText, jobData) {

  const response = await client.chat.completions.create({
    model: "deepseek/deepseek-chat-v3",
    temperature: 0.3,
    max_tokens: 1200,

    messages: [
      {
        role: "system",
        content: `
You are an experienced university placement coordinator.

Write a professional placement email body.

Content Rules:
- Human written tone
- Official placement cell style
- Include all important details
- If internship details are present, include: internship duration, monthly stipend, and the PPO package / CTC after internship separately
- If a full salary/CTC breakdown is available (fixed pay, bonuses, totals, etc.), present each component as its own line
- Include eligibility criteria (eligible courses/branches, batch year, minimum CGPA)
- Include selection process and assessment details (e.g. mode of assessment, programming languages for the test, where it will be conducted)
- Include work location / office address if mentioned (in addition to general location)
- Include registration deadline with both date and time if available
- Include instructions and a registration/application link if available
- Well organized and easy to read
- Ready to send to students
- Do NOT sound AI generated
- Do not invent or assume details that are not present in the extracted data or original notification

Formatting Rules (very important):
- Output PLAIN TEXT only. Do NOT use Markdown.
- Do NOT use asterisks (*), hashes (#), backticks, underscores, or any markdown symbols anywhere in the output.
- Do NOT wrap words or labels in ** for bold or _ for italic.
- Do NOT add any preamble, title, or label before the email content, such as "Email Body:", "Subject:", "Here is the email:", etc. Output ONLY the email content itself, starting directly with the greeting (e.g. "Dear Students,").
- For section titles, write them as plain text on their own line followed by a colon, e.g.:
  Eligibility Criteria:
- For lists, each item MUST be on its own separate line, starting with a hyphen and space. NEVER put multiple "- " items on the same line. For example, write:
  - CTC: 24 LPA
  - Base Salary: 18 LPA
  - Joining Bonus: 3 LPA
  NOT: "- CTC: 24 LPA - Base Salary: 18 LPA - Joining Bonus: 3 LPA" on one line.
- Do NOT use "---" or any horizontal rule / divider lines.
- Leave a blank line between each section/paragraph for readability.

Signature Rules (very important):
- Do NOT include any greeting sign-off, signature, name, designation, email, or phone number at the end.
- Do NOT write "Regards", "Warm regards", "Sincerely", "Ayush Shukla", "Placement Coordinator", "CPDD GCET", contact details, or any closing note.
- The email body should end right after the last instruction or informational line (e.g. after "For any queries, contact the placement cell." or similar). The signature block will be added separately by the system.
`
      },
      {
        role: "user",
        content: `
Original Notification:

${originalText}

Extracted Data:

${JSON.stringify(jobData, null, 2)}
`
      }
    ]
  });

  return response.choices[0].message.content;
}

// ----------------------------------------------------------------
// Generate a custom email based on a free-form user instruction,
// e.g. "I need to inform my classmates about a workshop on Friday,
// write a mail for it."
// ----------------------------------------------------------------
async function generateCustomMail(userInstruction) {
  const response = await client.chat.completions.create({
    model: "deepseek/deepseek-chat-v3",
    temperature: 0.4,
    max_tokens: 1200,

    messages: [
      {
        role: "system",
        content: `
You are an assistant that writes professional emails on behalf of the user.

The user will describe what they need in their own words (e.g. "I need to tell my classmates about a workshop on Friday, write a mail for it"). Your job is to write the actual email body based on that instruction.

Content Rules:
- Understand the user's intent and write the email content they are asking for.
- Use a polite, clear, professional tone suitable for sending to classmates, faculty, groups, or other recipients.
- Include all relevant details the user mentioned (dates, times, venues, links, names, etc.) accurately. Do not invent details the user did not provide.
- If the user's instruction is itself the message they want sent (e.g. "tell everyone the meeting is postponed to 5pm"), turn it into a well-written email body conveying that message.
- Keep it concise and well organized.
- Do NOT sound AI generated.

Formatting Rules (very important):
- Output PLAIN TEXT only. Do NOT use Markdown.
- Do NOT use asterisks (*), hashes (#), backticks, underscores, or any markdown symbols anywhere in the output.
- Do NOT wrap words or labels in ** for bold or _ for italic.
- Do NOT add any preamble, title, or label before the email content, such as "Email Body:", "Subject:", "Here is the email:", etc. Output ONLY the email content itself, starting directly with a greeting if appropriate.
- For section titles (if any), write them as plain text on their own line followed by a colon.
- For lists, each item MUST be on its own separate line, starting with a hyphen and space. NEVER put multiple "- " items on the same line.
- Do NOT use "---" or any horizontal rule / divider lines.
- Leave a blank line between each section/paragraph for readability.

Signature Rules (very important):
- Do NOT include any greeting sign-off, signature, name, designation, email, or phone number at the end.
- Do NOT write "Regards", "Warm regards", "Sincerely", or any closing note, unless the user explicitly asked you to include a specific signature.
- The email body should end right after the last informational line. A signature block will be added separately by the system unless the user specified otherwise.
`
      },
      {
        role: "user",
        content: userInstruction
      }
    ]
  });

  return response.choices[0].message.content;
}

// ----------------------------------------------------------------
// Extract text/content from an image (e.g. a photo of a placement
// notification, poster, or screenshot) using a free vision model
// on OpenRouter.
//
// base64Image: base64-encoded image data (no data: prefix)
// mimeType: e.g. "image/jpeg", "image/png"
// ----------------------------------------------------------------
async function extractTextFromImage(base64Image, mimeType) {
  try {
    const response = await client.chat.completions.create({
      model: "qwen/qwen2.5-vl-72b-instruct:free",
      temperature: 0,
      max_tokens: 1500,

      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `
This image contains a placement / job / internship notification (it could be a poster, screenshot, message, or document page).

Carefully read and transcribe ALL text visible in the image, including:
- Company name
- Role / position
- CTC / salary / stipend
- Location
- Eligibility criteria (branches, CGPA, batch)
- Important dates / deadlines
- Application instructions / links
- Any other relevant details

Return the extracted information as plain readable text (not JSON), preserving as much detail as possible. If some text is unclear, make your best guess. Do not add any commentary, explanation, or markdown formatting — just the transcribed content.
`
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`
              }
            }
          ]
        }
      ]
    });

    const content = response.choices[0].message.content;
    return content ? content.trim() : "";

  } catch (error) {
    console.error("OpenRouter Vision Error:", error);
    return "";
  }
}

// ----------------------------------------------------------------
// Generate a short, WhatsApp-friendly placement notice with emojis,
// based on the original notification and extracted job data.
// ----------------------------------------------------------------
async function generateWhatsappMessage(originalText, jobData) {
  const response = await client.chat.completions.create({
    model: "deepseek/deepseek-chat-v3",
    temperature: 0.4,
    max_tokens: 600,

    messages: [
      {
        role: "system",
        content: `
You are a university placement coordinator writing a WhatsApp broadcast message for a student group.

Content Rules:
- Write a SHORT, scannable WhatsApp message (not a full email).
- Use relevant emojis to make it visually engaging (e.g. 📢 🏢 💼 💰 📍 📅 🔗 📝), but do not overuse them.
- Include the most important details only: company name, role, package/CTC or stipend, eligible batch/branches, deadline, and the application/registration link if available.
- If internship + PPO details exist, mention both briefly.
- Keep total length short enough to read at a glance on a phone (roughly 8-15 lines).
- End with a short call-to-action encouraging students to apply before the deadline.
- Tone: friendly but informative, suitable for a college placement WhatsApp group.

Formatting Rules (very important):
- Output PLAIN TEXT only. Do NOT use Markdown (no **, no #, no backticks).
- Each piece of information should be on its own line.
- Do NOT add any preamble like "Here's the WhatsApp message:" - output only the message itself.
- Do NOT include a signature, name, or designation at the end.
`
      },
      {
        role: "user",
        content: `
Original Notification:

${originalText}

Extracted Data:

${JSON.stringify(jobData, null, 2)}
`
      }
    ]
  });

  return response.choices[0].message.content;
}

module.exports = {
  extractJobDetails,
  generateProfessionalMail,
  extractTextFromImage,
  generateCustomMail,
  generateWhatsappMessage
};