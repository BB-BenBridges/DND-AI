# D&D AI Session Summaries

This project is a Next.js application for Dungeon Masters who want quick post-game notes. Upload an audio recording from your tabletop session, list the player names, and the app will transcribe the conversation and generate individualized bullet-point summaries for each participant.

## Features
- Upload session audio (up to 100 MB) and stream progress updates while it processes
- Automatic transcription powered by OpenAI Whisper (`whisper-1`)
- Player-specific recap bullets generated with OpenAI `gpt-4o-mini`
- Client UI for managing player lists and reviewing transcripts or summaries in one place

## Prerequisites
- Node.js 18 or later
- Yarn or npm for dependency management
- An OpenAI API key (`OPENAI_KEY`) with access to Whisper and GPT-4o models

## Getting Started
1. Install dependencies:
   ```bash
   yarn install
   # or
   npm install
   ```
2. Configure environment variables by creating a `.env.local` file and setting:
   ```bash
   OPENAI_KEY=your_api_key_here
   ```
3. Run the development server:
   ```bash
   yarn dev
   ```
4. Visit `http://localhost:3000` to upload audio and generate summaries.

## Project Structure Highlights
- `pages/index.tsx` – React UI for managing players, uploading audio, and rendering streaming results
- `pages/api/session-summary.ts` – Handles multipart uploads, performs transcription, and returns structured summary data

## Notes
- Some of the code in this repository has been written with the help of AI tools.
- Transcription and summarization rely on third-party APIs; usage costs apply according to your OpenAI plan.

