import { useState } from "react";
import type { AgentInteraction } from "../../ai/agent";

export function InteractionCard({ interaction, busy, onAnswer, onDismiss }: { interaction: AgentInteraction; busy: boolean; onAnswer: (result: unknown, ok: boolean) => void; onDismiss: () => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  return (
    <section className="w-question">
      {interaction.questions.map((question) => (
        <fieldset key={question.id}>
          <legend>{question.question}</legend>
          {question.options.map((option) => (
            <label key={option.id} className={`w-option ${answers[question.id] === option.id ? "active" : ""}`}>
              <input type="radio" name={question.id} checked={answers[question.id] === option.id} onChange={() => setAnswers((current) => ({ ...current, [question.id]: option.id }))} />
              <span><b>{option.label}</b>{option.description ? <small>{option.description}</small> : null}</span>
            </label>
          ))}
        </fieldset>
      ))}
      <textarea className="w-textarea" rows={2} placeholder="补充说明（可选）" value={note} onChange={(event) => setNote(event.currentTarget.value)} />
      <div className="w-row">
        <button type="button" className="w-btn primary" disabled={busy || interaction.questions.some((question) => !answers[question.id])} onClick={() => onAnswer({ answers: interaction.questions.map((question) => ({ question: question.question, answer: question.options.find((option) => option.id === answers[question.id])?.label })), note }, true)}>提交</button>
        <button type="button" className="w-btn ghost" disabled={busy} onClick={onDismiss}>结束任务</button>
      </div>
    </section>
  );
}
