export async function refineFeedbackWithLLM(text: string, feedback: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const baseURL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

  if (!apiKey) {
    throw new Error('LLM feedback refinement requires OPENAI_API_KEY');
  }

  const systemPrompt = `You are a sales collateral editor. Apply the user's feedback to improve the provided text. Keep the improved version concise, punchy, and focused on the buyer's perspective. Return only the refined text, no explanations.`;

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Original text:\n\n${text}\n\nFeedback to apply:\n${feedback}\n\nRefined text:`,
      },
    ],
    temperature: 0.7,
    max_tokens: 1024,
  };

  try {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(`LLM feedback refinement failed: ${res.status} ${err.error}`);
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    if (!Array.isArray(data.choices) || data.choices.length === 0) {
      throw new Error('LLM returned empty choices array');
    }

    const refined = data.choices[0]?.message?.content?.trim();
    if (!refined || refined.length === 0) {
      throw new Error('LLM returned empty response');
    }

    return refined;
  } catch (err) {
    throw new Error(
      `LLM feedback refinement threw: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
