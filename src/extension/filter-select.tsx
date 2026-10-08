import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as SelectPrimitive from '@radix-ui/react-select';

// shadcn/ui Select composition, styled with the extension's standalone CSS.
const controls = new Map<HTMLSelectElement, Root>();

function FilterSelect({ select }: { select: HTMLSelectElement }) {
  const [open, setOpen] = React.useState(false);
  const options = Array.from(select.options);
  const label = document.querySelector(`label[for="${select.id}-trigger"]`);
  return (
    <SelectPrimitive.Root
      open={open}
      onOpenChange={setOpen}
      value={String(Math.max(0, select.selectedIndex))}
      disabled={select.disabled}
      onValueChange={index => {
        select.value = options[Number(index)].value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }}
    >
      <SelectPrimitive.Trigger
        id={`${select.id}-trigger`}
        className="select-trigger"
        aria-label={label?.textContent || 'Filter'}
        onPointerDown={event => {
          // Open on click rather than Radix's mouse pointerdown, so the popup
          // mounts after the click target is settled inside the filter panel.
          if (event.button === 0 && event.pointerType === 'mouse') event.preventDefault();
        }}
        onClick={event => {
          event.preventDefault();
          event.currentTarget.focus();
          setOpen(previous => !previous);
        }}
      >
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon asChild>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content className="select-content" data-filter-select-content="" position="popper" sideOffset={5} collisionPadding={12}>
          <SelectPrimitive.ScrollUpButton className="select-scroll" aria-label="Scroll up">⌃</SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="select-viewport">
            {options.map((option, index) => (
              <SelectPrimitive.Item key={option.value} value={String(index)} disabled={option.disabled} className="select-item" title={option.text}>
                <SelectPrimitive.ItemText>{option.text}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="select-check" aria-hidden="true">✓</SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="select-scroll" aria-label="Scroll down">⌄</SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function mountFilterSelects(): void {
  for (const id of ['filter-source', 'filter-board', 'filter-folder', 'filter-time']) {
    const select = document.getElementById(id) as HTMLSelectElement;
    const host = document.createElement('div');
    host.className = 'select-host';
    select.after(host);
    select.hidden = true;
    const label = document.querySelector(`label[for="${id}"]`);
    label?.setAttribute('for', `${id}-trigger`);
    controls.set(select, createRoot(host));
  }
  refreshFilterSelects();
}

export function refreshFilterSelects(): void {
  for (const [select, root] of controls) root.render(<FilterSelect select={select} />);
}
