export const AMOUNT_PATTERNS = [
  /(?:pay|send|bheju|de|bhejo)\s+(?:rupees?|rs\.?|₹)?\s*(\d+(?:\.\d{1,2})?)/i,
  /(\d+(?:\.\d{1,2})?)\s*(?:rupees?|rs\.?|₹)/i,
  /(?:rupees?|rs\.?|₹)\s*(\d+(?:\.\d{1,2})?)/i,
];

export const WORD_TO_NUM = {
  'zero':0,'one':1,'two':2,'three':3,'four':4,'five':5,'six':6,
  'seven':7,'eight':8,'nine':9,'ten':10,'eleven':11,'twelve':12,
  'thirteen':13,'fourteen':14,'fifteen':15,'sixteen':16,'seventeen':17,
  'eighteen':18,'nineteen':19,'twenty':20,'thirty':30,'forty':40,
  'fifty':50,'sixty':60,'seventy':70,'eighty':80,'ninety':90,
  'hundred':100,'thousand':1000,
  // Hindi numerals
  'ek':1,'do':2,'teen':3,'char':4,'paanch':5,'chhe':6,'saat':7,
  'aath':8,'nau':9,'das':10,'bees':20,'tees':30,'chalis':40,
  'pachas':50,'saath':60,'sattar':70,'assi':80,'nabbe':90,
  'sau':100,'hazaar':1000,
};

export function parseIntentRegex(text) {
  if (!text) return null;
  const cleanText = text.trim();

  let amount = null;

  // Try numeric patterns first
  for (const pattern of AMOUNT_PATTERNS) {
    const match = cleanText.match(pattern);
    if (match) {
      const amt = parseFloat(match[1]);
      if (amt > 0 && amt <= 100000) {
        amount = amt;
        break;
      }
    }
  }

  // Try word-based numbers if numeric failed
  if (amount === null) {
    const words = cleanText.toLowerCase().split(/\s+/);
    let total = 0, current = 0;
    for (const word of words) {
      const cleanWord = word.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
      const n = WORD_TO_NUM[cleanWord];
      if (n === undefined) continue;
      
      if (n === 100) { 
        current = (current || 1) * 100; 
      } else if (n === 1000) { 
        total += (current || 1) * 1000; 
        current = 0; 
      } else { 
        current += n; 
      }
    }
    const sum = total + current;
    if (sum > 0) amount = sum;
  }

  if (amount > 0) {
    // Extract item (e.g., "for Maggie", "for chai")
    let item = 'Maggie';
    const itemMatch = cleanText.match(/(?:for|of|purchase)\s+([a-zA-Z0-9\s]+?)(?:\s+to|\s+at|\s+towards|$)/i);
    if (itemMatch) {
      item = itemMatch[1].trim();
    }

    // Extract recipient (e.g., "to Eatery", "to Raju")
    let recipient = 'Eatery';
    const recipientMatch = cleanText.match(/(?:to|towards|at|for)\s+([a-zA-Z0-9\s]+?)(?:\s+for|of|$)/i);
    if (recipientMatch) {
      // Avoid matching item again if it was matched by 'for'
      const matchedName = recipientMatch[1].trim();
      if (matchedName.toLowerCase() !== item.toLowerCase()) {
        recipient = matchedName;
      }
    }

    return {
      amount,
      item,
      recipient,
      raw: cleanText,
      fallbackUsed: true
    };
  }

  return null;
}
