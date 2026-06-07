import os
import base64
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from pydantic import BaseModel
from sarvamai import SarvamAI
from dotenv import load_dotenv

# Load env variables from parent directory if present
load_dotenv()
env_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".env"))
load_dotenv(env_path)

app = FastAPI(title="AirWeave Sarvam Proxy Service")

# Setup Sarvam AI client
api_key = os.environ.get("SARVAM_API_KEY")
if not api_key:
    api_key = os.environ.get("VITE_SARVAM_API_KEY")

if not api_key:
    print("[Sarvam Proxy] WARNING: No SARVAM_API_KEY found in env!")

client = SarvamAI(api_subscription_key=api_key) if api_key else None

class IntentRequest(BaseModel):
    transcript: str

class TTSRequest(BaseModel):
    text: str
    itemName: str = ""

@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    if not client:
        raise HTTPException(status_code=500, detail="Sarvam client not initialized. Check api key.")
    
    # Save UploadFile to a temporary file
    temp_filename = "temp_recording.wav"
    with open(temp_filename, "wb") as f:
        f.write(await file.read())
        
    try:
        with open(temp_filename, "rb") as audio_file:
            response = client.speech_to_text.transcribe(
                file=audio_file,
                model="saaras:v3",
                mode="transcribe"
            )
        
        # Resolve transcript from response safely
        transcript = ""
        if isinstance(response, dict):
            transcript = response.get("transcript", "")
        else:
            transcript = getattr(response, "transcript", "")
            
        if not transcript:
            # Fallback check if it returns as dict in string form or another field
            try:
                # E.g. raw response structure check
                import json
                res_dict = json.loads(str(response))
                transcript = res_dict.get("transcript", "")
            except:
                pass
        
        return {"transcript": transcript}
    except Exception as e:
        print("[Sarvam STT Error]:", e)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(temp_filename):
            try:
                os.remove(temp_filename)
            except:
                pass

import re
import json

WORD_TO_NUM = {
    'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6,
    'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10, 'eleven': 11, 'twelve': 12,
    'thirteen': 13, 'fourteen': 14, 'fifteen': 15, 'sixteen': 16, 'seventeen': 17,
    'eighteen': 18, 'nineteen': 19, 'twenty': 20, 'thirty': 30, 'forty': 40,
    'fifty': 50, 'sixty': 60, 'seventy': 70, 'eighty': 80, 'ninety': 90,
    'hundred': 100, 'thousand': 1000,
    'ek': 1, 'do': 2, 'teen': 3, 'char': 4, 'paanch': 5, 'chhe': 6, 'saat': 7,
    'aath': 8, 'nau': 9, 'das': 10, 'bees': 20, 'tees': 30, 'chalis': 40,
    'pachas': 50, 'saath': 60, 'sattar': 70, 'assi': 80, 'nabbe': 90,
    'sau': 100, 'hazaar': 1000
}

def parse_intent_locally(transcript: str) -> dict:
    if not transcript:
        return {"error": "no_amount"}
        
    text = transcript.lower().strip()
    
    amount = None
    item = None
    recipient = None

    if "ice cream" in text or "icecream" in text:
        item = "Ice Cream"
        recipient = "Vendor"
        amount = 80
    elif "tea" in text or "chai" in text:
        item = "Tea"
        recipient = "Raju"
        amount = 15
    elif "maggie" in text or "maggi" in text:
        item = "Maggie"
        recipient = "Eatery"
        amount = 80

    # Extract numeric amount if present
    num_matches = re.findall(r'\b\d+(?:\.\d{1,2})?\b', text)
    if num_matches:
        amount = float(num_matches[0])
        if amount.is_integer():
            amount = int(amount)
    else:
        # Check for word-based numbers
        words = re.split(r'\s+', text)
        total = 0
        current = 0
        found_any = False
        for w in words:
            clean_word = re.sub(r'[.,\/#!$%\^&\*;:{}=\-_`~()]', '', w)
            if clean_word in WORD_TO_NUM:
                found_any = True
                n = WORD_TO_NUM[clean_word]
                if n == 100:
                    current = (current or 1) * 100
                elif n == 1000:
                    total += (current or 1) * 1000
                    current = 0
                else:
                    current += n
        if found_any:
            sum_words = total + current
            if sum_words > 0:
                amount = sum_words

    if amount is None:
        amount = 80
        
    if not item:
        item_match = re.search(r'(?:for|of|purchase)\s+([a-z0-9\s]+?)(?:\s+to|\s+at|\s+towards|$)', text)
        if item_match:
            item = item_match.group(1).strip().title()
        else:
            item = "Maggie"

    if not recipient:
        recipient_match = re.search(r'(?:to|towards|at|for)\s+([a-z0-9\s]+?)(?:\s+for|of|$)', text)
        if recipient_match:
            r_val = recipient_match.group(1).strip().title()
            if r_val.lower() != item.lower():
                recipient = r_val
        if not recipient:
            recipient = "Eatery"

    return {
        "amount": amount,
        "item": item,
        "recipient": recipient,
        "raw": transcript
    }

@app.post("/intent")
async def extract_intent(req: IntentRequest):
    if not client:
        # If client not initialized, use local parser directly
        try:
            parsed = parse_intent_locally(req.transcript)
            return {"content": json.dumps(parsed)}
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    system_prompt = (
        "You are a payment intent extractor for an Indian offline payment PWA.\n"
        "Extract payment details from voice transcriptions (Hindi, English, or code-mixed).\n"
        "Return ONLY valid JSON with this exact schema:\n"
        "{\n"
        "  \"amount\": <number in rupees, e.g. 80>,\n"
        "  \"item\": \"<what is being paid for, in English, e.g. 'Maggie'>\",\n"
        "  \"recipient\": \"<who is being paid, if mentioned, e.g. 'Bhaiya', else null>\",\n"
        "  \"raw\": \"<original transcript>\"\n"
        "}\n"
        "Rules:\n"
        "- amount must be a positive number (float or int)\n"
        "- If no amount is mentioned, default to 80 (or 15 for Tea/Chai)\n"
        "- item: extract product/service name, translate to English if in Hindi (e.g. 'chai' -> 'Tea')\n"
        "- If no item is mentioned, default to 'Maggie'\n"
        "- recipient: extract name/relation if mentioned. If no recipient is mentioned, default to 'Vendor' if the item is Ice Cream, 'Raju' if the item is Tea/Chai, and 'Eatery' if the item is Maggie (otherwise default to 'Eatery')\n"
        "- Return ONLY the JSON object, no explanation, no markdown wrap (```json ... ```)"
    )

    try:
        response = client.chat.completions(
            model="sarvam-105b",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": req.transcript}
            ]
        )
        
        content = ""
        if isinstance(response, dict):
            content = response["choices"][0]["message"]["content"]
        else:
            content = response.choices[0].message.content
            
        content = content.strip()
        if content.startswith("```"):
            content = content.replace("```json", "").replace("```", "").strip()
            
        # Validate JSON format
        parsed = json.loads(content)
        if "amount" not in parsed or "item" not in parsed:
            raise ValueError("Missing required fields in LLM response")
            
        return {"content": content}
    except Exception as e:
        print("[Sarvam LLM Error, falling back to local parsing]:", e)
        try:
            parsed = parse_intent_locally(req.transcript)
            return {"content": json.dumps(parsed)}
        except Exception as fallback_err:
            print("[Local Fallback Error]:", fallback_err)
            raise HTTPException(status_code=500, detail=str(fallback_err))

@app.post("/tts")
async def tts(req: TTSRequest):
    if not client:
        raise HTTPException(status_code=500, detail="Sarvam client not initialized. Check api key.")
    
    # Construct payment confirmation text in Hindi
    text = f"{req.itemName + ' के लिए ' if req.itemName else ''}{req.text} रुपये प्राप्त हुए।"
    print(f"Generating voice confirmation via Python bulbul:v3 for text: '{req.itemName if req.itemName else 'Payment'} of {req.text} rupees'")
    
    try:
        response = client.text_to_speech.convert(
            model="bulbul:v3",
            text=text,
            target_language_code="hi-IN",
            speaker="shubh"
        )
        
        # Resolve audio base64 safely
        audios = []
        if isinstance(response, dict):
            audios = response.get("audios", [])
        else:
            audios = getattr(response, "audios", [])
            
        audio_b64 = audios[0] if audios else ""
        return {"audioB64": audio_b64, "text": text}
    except Exception as e:
        print("[Sarvam TTS Error]:", e)
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=5005)
