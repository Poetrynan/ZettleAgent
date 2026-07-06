import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useBase } from '../../contexts/BaseContext';
import { t } from '../../lib/i18n';
import {
  openOrCreateDailyNoteForDate,
  listDailyNotes,
  DailyNoteInfo
} from '../../lib/dailyNote';
import { exists } from '@tauri-apps/plugin-fs';
import {
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
  IconEdit,
  IconEmpty
} from '../icons';
import { MarkdownRenderer } from '../editor/MarkdownRenderer';
import '../../styles/DailyCalendar.css';

export default function DailyCalendar() {
  const { state, setView, setCurrentFile, showToast } = useBase();
  const [selectedDate, setSelectedDate] = useState<string>(() => {
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  });

  const [currentYear, setCurrentYear] = useState<number>(() => new Date().getFullYear());
  const [currentMonth, setCurrentMonth] = useState<number>(() => new Date().getMonth()); // 0-11
  const [dailyNotes, setDailyNotes] = useState<Record<string, DailyNoteInfo>>({});
  const [loading, setLoading] = useState<boolean>(true);

  // Load all daily notes
  const loadNotes = async () => {
    setLoading(true);
    try {
      const notes = await listDailyNotes();
      setDailyNotes(notes);
    } catch (e) {
      console.error('Failed to load daily notes for calendar:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (state.view === 'calendar') {
      loadNotes();
    }
    const onDailyNotesChanged = () => { loadNotes(); };
    window.addEventListener('zettel:daily-notes-changed', onDailyNotesChanged);
    return () => window.removeEventListener('zettel:daily-notes-changed', onDailyNotesChanged);
  }, [state.view]);

  // Statistics calculation
  const stats = useMemo(() => {
    const notesArray = Object.values(dailyNotes);
    const totalNotes = notesArray.length;
    const totalWords = notesArray.reduce((sum, note) => sum + note.wordCount, 0);
    const avgWords = totalNotes > 0 ? Math.round(totalWords / totalNotes) : 0;
    return { totalNotes, totalWords, avgWords };
  }, [dailyNotes]);

  // Selected note details
  const selectedNote = useMemo(() => {
    return dailyNotes[selectedDate] || null;
  }, [selectedDate, dailyNotes]);

  // Dropdown options
  const years = useMemo(() => {
    const thisYear = new Date().getFullYear();
    const list = [];
    for (let y = thisYear - 10; y <= thisYear + 5; y++) {
      list.push(y);
    }
    return list;
  }, []);

  const months = useMemo(() => {
    const locale = state.lang === 'zh' ? 'zh-CN' : 'en-US';
    return Array.from({ length: 12 }, (_, i) => {
      const date = new Date(2000, i, 1);
      return {
        value: i,
        label: date.toLocaleString(locale, { month: 'long' }),
        short: state.lang === 'zh'
          ? `${i + 1}月`
          : date.toLocaleString(locale, { month: 'short' }),
      };
    });
  }, [state.lang]);

  const [yearOpen, setYearOpen] = useState(false);
  const [monthOpen, setMonthOpen] = useState(false);
  const yearPickerRef = useRef<HTMLDivElement>(null);
  const monthPickerRef = useRef<HTMLDivElement>(null);

  const closePickers = useCallback(() => {
    setYearOpen(false);
    setMonthOpen(false);
  }, []);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (yearPickerRef.current?.contains(target) || monthPickerRef.current?.contains(target)) return;
      closePickers();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [closePickers]);

  // Navigation handlers
  const handlePrevMonth = () => {
    if (currentMonth === 0) {
      setCurrentMonth(11);
      setCurrentYear(prev => prev - 1);
    } else {
      setCurrentMonth(prev => prev - 1);
    }
  };

  const handleNextMonth = () => {
    if (currentMonth === 11) {
      setCurrentMonth(0);
      setCurrentYear(prev => prev + 1);
    } else {
      setCurrentMonth(prev => prev + 1);
    }
  };

  const handleGoToday = () => {
    const today = new Date();
    setCurrentYear(today.getFullYear());
    setCurrentMonth(today.getMonth());
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    setSelectedDate(`${y}-${m}-${d}`);
  };

  // Open or Create Note for selected date
  const handleOpenOrCreate = async (dateStr: string) => {
    try {
      const path = await openOrCreateDailyNoteForDate(dateStr);
      // Verify the file actually exists before trying to open it
      const existsCheck = await exists(path);
      if (!existsCheck) {
        throw new Error('File was not created successfully');
      }
      setCurrentFile(path);
      setView('note');
      showToast(`${t('sidebar.dailyNote')}: ${dateStr}`, 'success');
    } catch (err) {
      console.error('Failed to open or create daily note:', err);
      showToast(t('common.error') + ': ' + (err as Error)?.message, 'error');
    }
  };

  // Grid generation
  const daysInGrid = useMemo(() => {
    // Index of the first day of the week (Monday: 0, Sunday: 6)
    const firstDayIndex = (new Date(currentYear, currentMonth, 1).getDay() + 6) % 7;
    const totalDays = new Date(currentYear, currentMonth + 1, 0).getDate();
    const prevMonthTotalDays = new Date(currentYear, currentMonth, 0).getDate();

    const grid = [];

    // 1. Fill previous month tail days
    for (let i = firstDayIndex - 1; i >= 0; i--) {
      const dayNum = prevMonthTotalDays - i;
      const prevMonth = currentMonth === 0 ? 11 : currentMonth - 1;
      const prevYear = currentMonth === 0 ? currentYear - 1 : currentYear;
      grid.push({
        dayNum,
        dateStr: `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`,
        isCurrentMonth: false
      });
    }

    // 2. Fill current month days
    for (let i = 1; i <= totalDays; i++) {
      grid.push({
        dayNum: i,
        dateStr: `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`,
        isCurrentMonth: true
      });
    }

    // 3. Fill next month head days to complete 42 cells (6 rows)
    const remainingCells = 42 - grid.length;
    for (let i = 1; i <= remainingCells; i++) {
      const nextMonth = currentMonth === 11 ? 0 : currentMonth + 1;
      const nextYear = currentMonth === 11 ? currentYear + 1 : currentYear;
      grid.push({
        dayNum: i,
        dateStr: `${nextYear}-${String(nextMonth + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`,
        isCurrentMonth: false
      });
    }

    return grid;
  }, [currentYear, currentMonth]);

  // Determine color contribution level based on word count
  const getContributionLevel = (wordCount: number): number => {
    if (wordCount === 0) return 0;
    if (wordCount < 100) return 1;
    if (wordCount < 500) return 2;
    if (wordCount < 1000) return 3;
    return 4;
  };

  const todayStr = useMemo(() => {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  }, []);

  return (
    <div className="calendar-container">
      <div className="calendar-main">
        {/* Header navigation section */}
        <header className="calendar-header">
          <div className="calendar-title-section">
            <div className="calendar-icon-wrapper">
              <IconCalendar size={26} />
            </div>
            <h1>{t('calendar.title')}</h1>
          </div>

          <div className="calendar-controls">
            {/* Year & Month selectors */}
            <div className="calendar-select-wrapper">
              <div className="calendar-picker" ref={yearPickerRef}>
                <button
                  type="button"
                  className={`calendar-picker-trigger ${yearOpen ? 'open' : ''}`}
                  aria-haspopup="listbox"
                  aria-expanded={yearOpen}
                  onClick={() => {
                    setYearOpen(v => !v);
                    setMonthOpen(false);
                  }}
                >
                  <span>{currentYear}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {yearOpen && (
                  <div className="calendar-picker-menu calendar-picker-menu--year" role="listbox">
                    {years.map(y => (
                      <button
                        key={y}
                        type="button"
                        role="option"
                        aria-selected={y === currentYear}
                        className={`calendar-picker-option ${y === currentYear ? 'active' : ''}`}
                        onClick={() => {
                          setCurrentYear(y);
                          setYearOpen(false);
                        }}
                      >
                        {y}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="calendar-picker" ref={monthPickerRef}>
                <button
                  type="button"
                  className={`calendar-picker-trigger calendar-picker-trigger--month ${monthOpen ? 'open' : ''}`}
                  aria-haspopup="listbox"
                  aria-expanded={monthOpen}
                  onClick={() => {
                    setMonthOpen(v => !v);
                    setYearOpen(false);
                  }}
                >
                  <span>{months[currentMonth]?.short}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {monthOpen && (
                  <div className="calendar-picker-menu calendar-picker-menu--month" role="listbox">
                    {months.map(m => (
                      <button
                        key={m.value}
                        type="button"
                        role="option"
                        aria-selected={m.value === currentMonth}
                        className={`calendar-picker-option ${m.value === currentMonth ? 'active' : ''}`}
                        title={m.label}
                        onClick={() => {
                          setCurrentMonth(m.value);
                          setMonthOpen(false);
                        }}
                      >
                        {m.short}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Navigation buttons */}
            <div className="calendar-nav-buttons">
              <button className="calendar-nav-btn" onClick={handlePrevMonth} title={t('calendar.prevMonth')}>
                <IconChevronLeft size={18} />
              </button>
              <div className="calendar-nav-divider" />
              <button className="calendar-nav-btn" onClick={handleNextMonth} title={t('calendar.nextMonth')}>
                <IconChevronRight size={18} />
              </button>
            </div>

            <button className="calendar-today-btn" onClick={handleGoToday}>
              {t('calendar.today')}
            </button>
          </div>
        </header>

        {/* Stats row cards */}
        <section className="calendar-stats-row">
          <div className="calendar-stat-card" style={{ animationDelay: '0s' }}>
            <span className="calendar-stat-val">{loading ? '...' : stats.totalNotes}</span>
            <span className="calendar-stat-lbl">{t('calendar.statsNotes')}</span>
          </div>
          <div className="calendar-stat-card" style={{ animationDelay: '0.1s' }}>
            <span className="calendar-stat-val">{loading ? '...' : stats.totalWords.toLocaleString()}</span>
            <span className="calendar-stat-lbl">{t('calendar.statsWords')}</span>
          </div>
          <div className="calendar-stat-card" style={{ animationDelay: '0.2s' }}>
            <span className="calendar-stat-val">{loading ? '...' : stats.avgWords.toLocaleString()}</span>
            <span className="calendar-stat-lbl">{t('calendar.statsAverage')}</span>
          </div>
        </section>

        {/* Month grid view */}
        <div className="calendar-grid-wrapper">
          <div className="calendar-week-days">
            <div className="calendar-week-day">{state.lang === 'zh' ? '一' : 'Mon'}</div>
            <div className="calendar-week-day">{state.lang === 'zh' ? '二' : 'Tue'}</div>
            <div className="calendar-week-day">{state.lang === 'zh' ? '三' : 'Wed'}</div>
            <div className="calendar-week-day">{state.lang === 'zh' ? '四' : 'Thu'}</div>
            <div className="calendar-week-day">{state.lang === 'zh' ? '五' : 'Fri'}</div>
            <div className="calendar-week-day">{state.lang === 'zh' ? '六' : 'Sat'}</div>
            <div className="calendar-week-day">{state.lang === 'zh' ? '日' : 'Sun'}</div>
          </div>

          <div className="calendar-grid">
            {daysInGrid.map((day, idx) => {
              const note = dailyNotes[day.dateStr];
              const wordCount = note ? note.wordCount : 0;
              const level = getContributionLevel(wordCount);
              const isToday = day.dateStr === todayStr;
              const isSelected = day.dateStr === selectedDate;

              return (
                <div
                  key={idx}
                  className={`calendar-day-cell ${day.isCurrentMonth ? '' : 'other-month'} ${day.isCurrentMonth ? `level-${level}` : ''} ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}`}
                  onClick={() => {
                    if (day.isCurrentMonth) {
                      setSelectedDate(day.dateStr);
                    }
                  }}
                  onDoubleClick={() => {
                    if (day.isCurrentMonth) {
                      handleOpenOrCreate(day.dateStr);
                    }
                  }}
                >
                  <span className="calendar-day-num">{day.dayNum}</span>
                  {day.isCurrentMonth && wordCount > 0 && (
                    <span className="calendar-cell-words">
                      {wordCount} {state.lang === 'zh' ? '字' : 'w'}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Bottom bar with Heatmap Legend */}
        <footer className="calendar-bottom-bar">
          <div className="calendar-legend">
            <span>{state.lang === 'zh' ? '少' : 'Less'}</span>
            <div className="calendar-legend-box l0" title="0 words" />
            <div className="calendar-legend-box l1" title="1-99 words" />
            <div className="calendar-legend-box l2" title="100-499 words" />
            <div className="calendar-legend-box l3" title="500-999 words" />
            <div className="calendar-legend-box l4" title="1000+ words" />
            <span>{state.lang === 'zh' ? '多' : 'More'}</span>
          </div>
        </footer>
      </div>

      {/* Right side preview panel */}
      <aside className="calendar-preview-panel animate-slide-in-right">
        <div className="preview-header">
          <div className="preview-header-info">
            <h2>{t('calendar.previewTitle').replace('{date}', selectedDate)}</h2>
            {selectedNote && (
              <span>
                {selectedNote.wordCount} {t('calendar.words')}
              </span>
            )}
          </div>
          <div className="preview-header-actions">
            <button
              className="preview-edit-btn"
              onClick={() => handleOpenOrCreate(selectedDate)}
            >
              <IconEdit size={16} />
              {t('calendar.edit')}
            </button>
          </div>
        </div>

        <div className="preview-content">
          {selectedNote ? (
            <div className="preview-markdown-wrapper">
              <MarkdownRenderer content={selectedNote.content} />
            </div>
          ) : (
            <div className="preview-empty">
              <span className="preview-empty-icon">
                <IconEmpty size={52} />
              </span>
              <h3>{t('calendar.noNote')}</h3>
              <p>{t('calendar.noNoteDesc')}</p>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
