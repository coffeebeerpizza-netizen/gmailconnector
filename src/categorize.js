// Rule-based grouping of emails into "like kinds". No AI involved: just sender,
// subject and Gmail's own labels. Users can override per sender in the dashboard.

export const CATEGORIES = [
  "Conversations",
  "AI & Tech",
  "Food & Drink",
  "Travel & Housing",
  "Money & Finance",
  "Orders & Support",
  "News & Politics",
  "Promotions",
  "Other newsletters",
];

const RULES = [
  ["AI & Tech", /\b(ai|claude|anthropic|chatgpt|openai|gemini|notebooklm|llm|agents?|mcp|prompt|cowork|neuron|rundown|copilot|cursor|automation|code|developer|software|tech)\b/i],
  ["Food & Drink", /\b(food|cook|cooking|recipe|chef|restaurant|kitchen|flavor|beer|brew|wine|coffee|pizza|mezcal|bbq|barbecue|culinary|usfoods|menu|bread|eat)\b/i],
  ["Travel & Housing", /\b(travel|trip|flight|airline|hotel|rental|landlord|apartment|lease|visa|booking|airbnb|aeroplan|passport|residency)\b/i],
  ["Money & Finance", /\b(invoice|payment|bank|ira|retirement|invest|investment|tax|receipt|billing|statement|capital|credit|loan|fund)\b/i],
  ["Orders & Support", /\b(order|shipped|shipping|delivery|tracking|support|ticket|case|rma|warranty|repair|return|refund|cas-\d+)\b/i],
  ["News & Politics", /\b(politic|democrat|republican|election|oligarchy|congress|krugman|reich|war|venezuela|policy|news)\b/i],
];

const NOREPLY = /(no-?reply|do-?not-?reply|notifications?|newsletter|mailer|news@|info@|hello@|updates?@|marketing|substack\.com|beehiiv\.com|mail\.kit\.com)/i;

export function senderEmail(from) {
  const m = /<([^>]+)>/.exec(from || "");
  return (m ? m[1] : from || "").trim().toLowerCase();
}

export function senderName(from) {
  const m = /^\s*"?([^"<]*?)"?\s*</.exec(from || "");
  return (m && m[1].trim()) || senderEmail(from);
}

/** True when the email looks like it came from a person, not a list or a robot. */
export function isConversation({ from, labels = [], listUnsubscribe }) {
  if (listUnsubscribe) return false;
  if (NOREPLY.test(senderEmail(from))) return false;
  if (labels.includes("CATEGORY_PROMOTIONS")) return false;
  return true;
}

export function categorize(msg, overrides = {}) {
  const email = senderEmail(msg.from);
  if (overrides[email]) return overrides[email];
  if (isConversation(msg)) return "Conversations";
  const text = `${senderName(msg.from)} ${email} ${msg.subject || ""}`;
  for (const [cat, re] of RULES) if (re.test(text)) return cat;
  if ((msg.labels || []).includes("CATEGORY_PROMOTIONS")) return "Promotions";
  return "Other newsletters";
}

/** Pull a web (https) unsubscribe link out of a List-Unsubscribe header, if there is one. */
export function unsubscribeUrl(header) {
  const m = /<(https?:[^>]+)>/i.exec(header || "");
  return m ? m[1] : null;
}
