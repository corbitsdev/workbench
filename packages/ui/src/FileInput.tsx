import { useRef, type ChangeEvent, type ComponentPropsWithoutRef } from 'react';
import { Button } from './Button';
import { cn } from './utils';

interface FileInputProps extends Omit<ComponentPropsWithoutRef<'input'>, 'type' | 'className'> {
  triggerLabel: string;
  pendingLabel?: string;
  isPending?: boolean;
  className?: string;
  triggerClassName?: string;
}

function FileInput({
  triggerLabel,
  pendingLabel,
  isPending = false,
  className,
  triggerClassName,
  disabled,
  onChange,
  ...inputProps
}: FileInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isDisabled = disabled || isPending;

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange?.(event);
    event.target.value = '';
  };

  return (
    <div className={cn('w-full', className)}>
      <input
        ref={inputRef}
        type="file"
        disabled={isDisabled}
        onChange={handleChange}
        className="sr-only"
        {...inputProps}
      />
      <Button
        type="button"
        variant="secondary"
        disabled={isDisabled}
        onClick={() => inputRef.current?.click()}
        className={cn(
          'w-full border-dashed py-6 text-[13px] font-medium text-text-2 hover:border-orange/60 hover:text-text',
          triggerClassName
        )}
      >
        {isPending && pendingLabel ? pendingLabel : triggerLabel}
      </Button>
    </div>
  );
}

export { FileInput };
