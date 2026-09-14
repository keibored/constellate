import { Check, ListTodo, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Avatar } from '../../components/ui/Avatar';
import type { RoomTask } from '../../../../shared/roomState';
import '../../styles/tasks.css';

interface TaskBoardProps {
  tasks: RoomTask[]; ready: boolean; saving: boolean; error: string | null;
  onCreate: (title: string) => Promise<boolean>;
  onToggle: (id: string, completed: boolean) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onSync: () => Promise<boolean>;
}

export function TaskBoard({ tasks, ready, saving, error, onCreate, onToggle, onDelete, onSync }: TaskBoardProps) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const completed = tasks.filter((task) => task.completed).length;
  return (
    <section className="task-board" id="quests" aria-labelledby="quests-heading" aria-busy={saving}>
      <div className="task-heading"><h2 id="quests-heading"><ListTodo size={17} />Today's Quests</h2><button className="add-task-button" disabled={!ready || saving} onClick={() => setAdding(!adding)} aria-expanded={adding}>{adding ? <X size={13} /> : <Plus size={13} />}{adding ? 'Cancel' : 'Add task'}</button></div>
      <div className="quest-list">{tasks.map((task) => <div className={`quest-row${task.completed ? ' quest-row--done' : ''}`} key={task.id} data-task-id={task.id}><label className="quest-label"><input type="checkbox" checked={task.completed} disabled={!ready || saving} onChange={event => { void onToggle(task.id, event.target.checked); }} /><span className="quest-checkbox" aria-hidden="true">{task.completed && <Check size={12} strokeWidth={3} />}</span><span>{task.title}</span></label><span className="assigned-avatars"><Avatar avatar={task.creatorAvatar} label={`Created by ${task.creatorName}`} small labelled /></span><button className="icon-button quest-delete" aria-label={`Delete task: ${task.title}`} disabled={!ready || saving} onClick={() => { void onDelete(task.id); }}><X size={12} /></button></div>)}{!tasks.length && <p className="quest-empty">{ready ? 'A fresh page. Add a small goal together.' : 'Join the room to see its quests.'}</p>}</div>
      {adding && <form className="add-task-form" onSubmit={async event => { event.preventDefault(); const submitted = draft; if (await onCreate(submitted)) { setDraft(current => current === submitted ? '' : current); setAdding(false); } }}><input autoFocus value={draft} disabled={!ready || saving} maxLength={100} aria-label="New task" placeholder="One small thing to work on…" onChange={(event) => setDraft(event.target.value)} /><button className="add-task-button" disabled={!ready || saving || !draft.trim()}>Add</button></form>}
      {error && <p className="quest-error" role="status">{error} <button className="add-task-button" disabled={saving} onClick={() => { void onSync(); }}>Retry</button></p>}
      <div className="quest-footer"><span>{completed} of {tasks.length} complete</span><span>small steps count <span aria-hidden="true">✧</span></span></div>
    </section>
  );
}
