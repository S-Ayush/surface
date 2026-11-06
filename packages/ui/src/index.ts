// Design system (docs/05-design/design-system.md). Global CSS: `@surface/ui/styles.css`.
export { LABEL_HUES, THEMES, token } from './tokens.gen.js';
export type { LabelHue, Theme, Token } from './tokens.gen.js';
export { THEME_PREFERENCES, THEME_STORAGE_KEY, isThemePreference, resolveTheme } from './theme.js';
export type { ThemePreference } from './theme.js';
export { THEME_BOOTSTRAP_SCRIPT } from './theme-bootstrap.js';
export { PlatformProvider, detectPlatform, usePlatform } from './platform.js';
export type { Platform } from './platform.js';
export { ariaKeyShortcuts, keyLabels, parseChord, spokenShortcut } from './keys.js';

export { Avatar, AvatarGroup, avatarHue, initials } from './components/Avatar/Avatar.js';
export type { AvatarGroupProps, AvatarProps, AvatarSize } from './components/Avatar/Avatar.js';
export { Badge } from './components/Badge/Badge.js';
export type { BadgeProps } from './components/Badge/Badge.js';
export { Button } from './components/Button/Button.js';
export type { ButtonProps, ButtonSize, ButtonVariant } from './components/Button/Button.js';
export { Checkbox } from './components/Checkbox/Checkbox.js';
export type { CheckboxProps } from './components/Checkbox/Checkbox.js';
export { ColorPicker, HUE_NAMES } from './components/ColorPicker/ColorPicker.js';
export type { ColorPickerProps } from './components/ColorPicker/ColorPicker.js';
export { EmptyState } from './components/EmptyState/EmptyState.js';
export type { EmptyStateProps } from './components/EmptyState/EmptyState.js';
export { IconButton } from './components/IconButton/IconButton.js';
export type { IconButtonProps } from './components/IconButton/IconButton.js';
export { Input } from './components/Input/Input.js';
export type { InputProps } from './components/Input/Input.js';
export { Kbd } from './components/Kbd/Kbd.js';
export type { KbdProps } from './components/Kbd/Kbd.js';
export { ProgressBar } from './components/ProgressBar/ProgressBar.js';
export type { ProgressBarProps } from './components/ProgressBar/ProgressBar.js';
export { SegmentedControl } from './components/SegmentedControl/SegmentedControl.js';
export type {
  SegmentedControlProps,
  SegmentedOption,
} from './components/SegmentedControl/SegmentedControl.js';
export { Skeleton } from './components/Skeleton/Skeleton.js';
export type { SkeletonProps } from './components/Skeleton/Skeleton.js';
export { Spinner } from './components/Spinner/Spinner.js';
export type { SpinnerProps } from './components/Spinner/Spinner.js';
export { Switch } from './components/Switch/Switch.js';
export type { SwitchProps } from './components/Switch/Switch.js';
export { Tabs, TabsContent, TabsList, TabsTrigger } from './components/Tabs/Tabs.js';
export { Textarea } from './components/Textarea/Textarea.js';
export type { TextareaProps } from './components/Textarea/Textarea.js';
export { Tooltip, TooltipProvider, TOOLTIP_DELAY_MS } from './components/Tooltip/Tooltip.js';
export type { TooltipProps } from './components/Tooltip/Tooltip.js';
