import { Check, ListTodo, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Avatar } from '../../components/ui/Avatar';
import { mockTasks } from '../../data/mockRoom';
import type { Task } from '../../types/room';

export function TaskBoard() {
  const [tasks, setTasks] = useState<Task[]>(mockTasks);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const completed = tasks.filter((task) => task.completed).length;
  return (
    <section className="task-board" id="quests" aria-labelledby="quests-heading">
      <div className="task-heading"><h2 id="quests-heading"><ListTodo size={17} />Today's Quests</h2><button className="add-task-button" onClick={() => setAdding(!adding)} aria-expanded={adding}>{adding ? <X size={13} /> : <Plus size={13} />}{adding ? 'Cancel' : 'Add task'}</button></div>
      <div className="quest-list">{tasks.map((task) => <div className={`quest-row${task.completed ? ' quest-row--done' : ''}`} key={task.id}><label className="quest-label"><input type="checkbox" checked={task.completed} onChange={() => setTasks((current) => current.map((item) => item.id === task.id ? { ...item, completed: !item.completed } : item))} /><span className="quest-checkbox" aria-hidden="true">{task.completed && <Check size={12} strokeWidth={3} />}</span><span>{task.title}</span></label><span className="assigned-avatars">{task.assigneeIds.map((id) => <Avatar memberId={id} key={id} small labelled />)}</span></div>)}</div>
      {adding && <form className="add-task-form" onSubmit={(event) => { event.preventDefault(); if (!draft.trim()) return; setTasks((current) => [...current, { id: crypto.randomUUID(), title: draft.trim(), completed: false, assigneeIds: ['kei'] }]); setDraft(''); setAdding(false); }}><input autoFocus value={draft} maxLength={100} aria-label="New task" placeholder="One small thing to work on…" onChange={(event) => setDraft(event.target.value)} /><button className="add-task-button" disabled={!draft.trim()}>Add</button></form>}
      <div className="quest-footer"><span>{completed} of {tasks.length} complete</span><span>small steps count <span aria-hidden="true">✧</span></span></div>
    </section>
  );
}
