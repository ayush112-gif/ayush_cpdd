const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

async function extractJobDetails(text) {
  try {
    const response = await client.chat.completions.create({
      model: "google/gemini-2.0-flash-thinking-exp:free",
      temperature: 0,
      max_tokens: 800,

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

Rules:
1. Return only JSON.
2. No markdown.
3. No explanation.
4. Use empty string if data missing.
5. Use [] for missing arrays.
6. Never hallucinate.
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
    model: "google/gemini-2.0-flash-thinking-exp:free",
    temperature: 0.3,
    max_tokens: 900,

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
- If a full salary/CTC breakdown is available, present each component as its own line
- Include eligibility criteria (eligible courses/branches, batch year, minimum CGPA)
- Include selection process and assessment details
- Include registration deadline with both date and time if available
- Include instructions and a registration/application link if available
- Do NOT sound AI generated

Formatting Rules:
- Output PLAIN TEXT only. No Markdown, no asterisks, no hashes.
- Start directly with greeting e.g. "Dear Students,"
- For section titles: plain text on own line followed by colon e.g. "Eligibility Criteria:"
- For lists: each item on its own line starting with "- "
- Leave blank line between sections

Signature Rules:
- Do NOT include sign-off, signature, name, designation, or closing note.
- End after last informational line.
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

async function generateCustomMail(userInstruction) {
  const response = await client.chat.completions.create({
    model: "google/gemini-2.0-flash-thinking-exp:free",
    temperature: 0.4,
    max_tokens: 900,

    messages: [
      {
        role: "system",
        content: `
You are an assistant that writes professional emails on behalf of the user.

Content Rules:
- Understand the user's intent and write the email content they are asking for.
- Use a polite, clear, professional tone.
- Include all relevant details the user mentioned accurately.
- Do NOT sound AI generated.

Formatting Rules:
- Output PLAIN TEXT only. No Markdown, no asterisks, no hashes.
- Start directly with a greeting if appropriate.
- For lists: each item on its own line starting with "- "
- Leave blank line between sections

Signature Rules:
- Do NOT include sign-off, signature, name, or closing note.
- End after last informational line.
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

async function extractTextFromImage(base64Image, mimeType) {
  try {
    const response = await client.chat.completions.create({
      model: "google/gemini-2.0-flash-thinking-exp:free",
      temperature: 0,
      max_tokens: 800,

      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `
This image contains a placement / job / internship notification.

Carefully read and transcribe ALL text visible in the image, including:
- Company name, Role, CTC / salary / stipend, Location
- Eligibility criteria, Important dates / deadlines
- Application instructions / links

Return the extracted information as plain readable text (not JSON). Do not add commentary or markdown.
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

async function generateWhatsappMessage(originalText, jobData) {
  const response = await client.chat.completions.create({
    model: "google/gemini-2.0-flash-thinking-exp:free",
    temperature: 0.4,
    max_tokens: 400,

    messages: [
      {
        role: "system",
        content: `
You are a university placement coordinator writing a WhatsApp broadcast message for a student group.

Content Rules:
- SHORT, scannable WhatsApp message
- Use relevant emojis (📢 🏢 💼 💰 📍 📅 🔗)
- Include: company name, role, package/CTC or stipend, eligible batch/branches, deadline, application link
- Keep total length 8-15 lines max
- End with a short call-to-action

Formatting Rules:
- Output PLAIN TEXT only. No Markdown.
- Each piece of info on its own line.
- No preamble, no signature.
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