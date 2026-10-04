'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { apiResponses } from '@sew/study-contracts';
import { apiFetch, describeApiError } from '../lib/client';

type QuestionType = 'single' | 'multiple' | 'short_answer';

export function QuestionAuthoring({ projectId, generation, knowledge }: {
  projectId: string;
  generation: number;
  knowledge: Array<{ knowledgeId: string; name: string; admitted: boolean }>;
}) {
  const router = useRouter();
  const [type, setType] = useState<QuestionType>('single');
  const [stem, setStem] = useState('');
  const [options, setOptions] = useState(['', '', '', '']);
  const [correct, setCorrect] = useState<string[]>([]);
  const [answer, setAnswer] = useState('');
  const [solution, setSolution] = useState('');
  const [rubric, setRubric] = useState('答案集完全一致得满分，否则得 0 分。');
  const [maxScore, setMaxScore] = useState('1');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const admitted = knowledge.filter((point) => point.admitted);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busyRef.current) return;
    setError(null); setNote(null);
    const choiceOptions = options.flatMap((label, index) => label.trim() ? [{ value: String.fromCharCode(65 + index), label: label.trim() }] : []);
    const activeIds = selected.filter((id) => admitted.some((point) => point.knowledgeId === id));
    if (!activeIds.length) { setError('请先选择仍准入的知识点；没有准入知识点时不能保存。'); return; }
    if (type !== 'short_answer' && (choiceOptions.length < 2 || !correct.length
      || correct.some((value) => !choiceOptions.some((option) => option.value === value)))) {
      setError('选择题至少填写两个选项，并为已填写的选项选择正确答案。'); return;
    }
    if (type === 'short_answer' && !answer.trim()) { setError('请填写简答题参考答案。'); return; }
    busyRef.current = true; setBusy(true);
    try {
      await apiFetch('/api/study/questions', apiResponses.questionCreate, {
        method: 'POST',
        body: JSON.stringify({ scope: { projectId, generation }, stem: stem.trim(),
          answer: type === 'short_answer' ? answer.trim() : correct.join('、'), solution: solution.trim(),
          knowledgeIds: activeIds, requestedOrigin: 'ai_new', originRecord: null,
          assessment: { schemaVersion: 1, type, options: type === 'short_answer' ? [] : choiceOptions,
            correctAnswers: type === 'short_answer' ? [] : [...correct].sort(), maxScore: Number(maxScore), rubric: rubric.trim(), answerVersion: 1 },
        }),
      });
      setNote('新编题与评分规则已保存。请在证据包中选择此题，再审核并发布课程版本。');
      setStem(''); setAnswer(''); setSolution(''); setCorrect([]); setOptions(['', '', '', '']);
      router.refresh();
    } catch (caught) { setError(describeApiError(caught)); }
    finally { busyRef.current = false; setBusy(false); }
  };

  return <section className="card" data-question-authoring>
    <h2>登记题目与评分规则</h2>
    <p className="muted">出处类别：新编。创建后须在证据包选题，并对课程版本进行人工审核后才能正式上课。简答题提交后保留待判分，不凭参考答案的文本匹配更新掌握。</p>
    {!admitted.length ? <p role="status">尚无准入知识点。请先核实来源、审核知识点并确认计划；当前不能保存题目。</p> : null}
    <form onSubmit={(event) => void save(event)}>
      <fieldset disabled={busy || !admitted.length}>
        <div className="field"><label htmlFor="qa-type">题型</label><select id="qa-type" value={type} onChange={(event) => {
          const value = event.target.value as QuestionType; setType(value); setCorrect([]);
          setRubric(value === 'short_answer' ? '' : '答案集完全一致得满分，否则得 0 分。');
        }}><option value="single">单选题</option><option value="multiple">多选题</option><option value="short_answer">简答题</option></select></div>
        <div className="field"><label htmlFor="qa-stem">题干</label><textarea id="qa-stem" required minLength={2} value={stem} onChange={(event) => setStem(event.target.value)} /></div>
        <div className="field"><span>绑定已准入知识点</span>{admitted.map((point) => <label key={point.knowledgeId} className="check-list"><input type="checkbox" data-knowledge-id={point.knowledgeId} checked={selected.includes(point.knowledgeId)} onChange={(event) => setSelected(event.target.checked ? [...selected, point.knowledgeId] : selected.filter((id) => id !== point.knowledgeId))} />{point.name}</label>)}</div>
        {type === 'short_answer' ? <div className="field"><label htmlFor="qa-answer">参考答案（不向课堂作答页面公开）</label><textarea id="qa-answer" required value={answer} onChange={(event) => setAnswer(event.target.value)} /></div> : options.map((label, index) => {
          const value = String.fromCharCode(65 + index);
          return <div className="field" key={value}><label htmlFor={`qa-option-${value}`}>选项 {value}</label><input id={`qa-option-${value}`} value={label} onChange={(event) => setOptions(options.map((item, position) => position === index ? event.target.value : item))} /><label htmlFor={`qa-correct-${value}`}><input id={`qa-correct-${value}`} type={type === 'single' ? 'radio' : 'checkbox'} name="qa-correct" checked={correct.includes(value)} onChange={(event) => setCorrect(type === 'single' ? [value] : event.target.checked ? [...correct, value] : correct.filter((item) => item !== value))} />正确答案 {value}</label></div>;
        })}
        <div className="field"><label htmlFor="qa-max-score">满分</label><input id="qa-max-score" type="number" min="0.01" max="1000" step="0.01" required value={maxScore} onChange={(event) => setMaxScore(event.target.value)} /></div>
        <div className="field"><label htmlFor="qa-rubric">评分标准</label><textarea id="qa-rubric" required value={rubric} readOnly={type !== 'short_answer'} onChange={(event) => setRubric(event.target.value)} /></div>
        <div className="field"><label htmlFor="qa-solution">解析（不向课堂作答页面公开）</label><textarea id="qa-solution" value={solution} onChange={(event) => setSolution(event.target.value)} /></div>
        <button type="submit" className="btn btn-primary">{busy ? '正在保存…' : '保存新编题与评分规则'}</button>
      </fieldset>
    </form>
    {error ? <p role="alert" className="error-text">{error}</p> : null}
    {note ? <p role="status">{note}</p> : null}
  </section>;
}
