# LexiFlow — B2 Vocabulary & Phrase Flashcards

An Anki-style spaced-repetition web app for reviewing **Vocabularies & Collocations** and **Phrases** with **US English** pronunciation.

## Features
- **Two-Stage Flashcard Flow**:
  1. **First Review (New cards)**: Front shows the word/phrase, US English IPA, and audio button (`en-US` TTS). Back shows the B2-level simple English meaning and a sample example.
  2. **Subsequent Reviews (Active Recall)**: Front shows the B2 meaning (with optional typing check & letter hint) so you actively recall the word. Back reveals the word, IPA, audio button, and example.
- **Anki SM-2 Spaced Repetition**: `Again`, `Hard`, `Good`, `Easy` scheduling. Cards rated `Again` repeat in the same session.
- **Separate Decks & Library**: Filter by `All`, `Vocabularies & Collocations`, or `Phrases`, plus search, add, edit, and bulk import.
- **Cross-Device Access**: Works offline via `localStorage` + JSON export/import, with optional free **Supabase** cloud sync.

## Hosting on Laptop & Phone (Free)
1. Upload the `vocab-app` folder to **Netlify Drop**, **Vercel**, or **GitHub Pages** to get a URL you can open on both your laptop and phone.
2. (Optional) Create a free project on [Supabase](https://supabase.com), run `supabase_schema.sql` in the SQL Editor, and paste your Project URL & Anon Key into the **Sync** modal in the app.
