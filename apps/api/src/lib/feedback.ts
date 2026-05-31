type CollateralType = 'email' | 'linkedin' | 'one-pager' | 'battlecard';

function buildFeedbackSystemPrompt(type: CollateralType): string {
  switch (type) {
    case 'linkedin':
      return `You are a sales copywriter editing a LinkedIn post. Apply the user's feedback strictly. Critical rules: never mention client names, company names, prospect names, or any identifying details — generalise to a category or job function. The insight must feel universal. Return only the refined text, no explanations.`;
    case 'email':
      return `You are a senior outbound sales rep editing a follow-up email. Apply the user's feedback. Keep the email sounding human — not a template. Vary sentence length, strip hollow adjectives, and make every word earn its place. Return only the refined text, no explanations.`;
    case 'one-pager':
      return `You are a sales copywriter editing a one-pager. Apply the user's feedback. Keep every section grounded in the prospect's specific numbers, team size, and language. Return only the refined text, no explanations.`;
    case 'battlecard':
      return `You are a sales copywriter editing paid ad copy. Apply the user's feedback. Keep each variant distinct in angle, headlines specific (use numbers or language from the context), and CTAs active and concrete. Return only the refined text, no explanations.`;
  }
}

export async function refineFeedbackWithLLM(
  text: string,
  feedback: string,
  type: CollateralType = 'email'
): Promise<string> {
  const apiKey = process.env.OPENAI_COMPATIBLE_API_KEY;
  const model = process.env.OPENAI_COMPATIBLE_MODEL || 'gpt-4o-mini';
  const baseURL = process.env.OPENAI_COMPATIBLE_BASE_URL || 'https://api.openai.com/v1';

  if (!apiKey) {
    throw new Error('LLM feedback refinement requires OPENAI_COMPATIBLE_API_KEY');
  }

  const systemPrompt = buildFeedbackSystemPrompt(type);

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
