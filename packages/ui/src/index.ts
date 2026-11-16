// Design system (docs/05-design/design-system.md). Global CSS: `@surface/ui/styles.css`.
export { LABEL_HUES, THEMES, token } from './tokens.gen.js';
export type { LabelHue, Theme, Token } from './tokens.gen.js';
export { THEME_PREFERENCES, THEME_STORAGE_KEY, isThemePreference, resolveTheme } from './theme.js';
export type { ThemePreference } from './theme.js';
export { THEME_BOOTSTRAP_SCRIPT } from './theme-bootstrap.js';
export { PlatformProvider, detectPlatform, usePlatform } from './platform.js';
export type { Platform } from './platform.js';
export { ariaKeyShortcuts, keyLabels, parseChord, spokenShortcut } from './keys.js';
export { VisuallyHidden } from './visually-hidden.js';

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

// Overlays (PLAN-005 S3)
export { OverlayProvider } from './overlays/OverlayProvider.js';
export {
  BANNER_PRIORITY,
  MAX_VISIBLE_TOASTS,
  OverlayManager,
  TOAST_ACTION_DURATION_MS,
  TOAST_DURATION_MS,
  banner,
  overlayManager,
  toast,
} from './overlays/manager.js';
export type {
  BannerAction,
  BannerOptions,
  BannerTone,
  LayerKind,
  OverlayLayer,
  OverlaySnapshot,
  ToastAction,
  ToastOptions,
  ToastTone,
} from './overlays/manager.js';
export { Banner, BannerRegion } from './components/Banner/Banner.js';
export type { BannerProps } from './components/Banner/Banner.js';
export { Dialog, DialogClose } from './components/Dialog/Dialog.js';
export type { DialogProps, DialogSize } from './components/Dialog/Dialog.js';
export { ContextMenu, Menu } from './components/Menu/Menu.js';
export type { ContextMenuProps, MenuEntry, MenuProps } from './components/Menu/Menu.js';
export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from './components/Popover/Popover.js';
export type { PopoverContentProps, PopoverProps } from './components/Popover/Popover.js';
export { ToastRegion } from './components/Toast/Toast.js';

// Issue list and page components (PLAN-012 S2)
export { StatusIcon } from './components/StatusIcon/StatusIcon.js';
export type { StatusIconProps } from './components/StatusIcon/StatusIcon.js';
export { PriorityIcon } from './components/PriorityIcon/PriorityIcon.js';
export type { PriorityIconProps } from './components/PriorityIcon/PriorityIcon.js';
export { LabelChip } from './components/LabelChip/LabelChip.js';
export type { LabelChipProps } from './components/LabelChip/LabelChip.js';
export { PropertyPill } from './components/PropertyPill/PropertyPill.js';
export type { PropertyPillProps } from './components/PropertyPill/PropertyPill.js';
export { PropertyPicker } from './components/PropertyPicker/PropertyPicker.js';
export type {
  PropertyPickerOption,
  PropertyPickerProps,
} from './components/PropertyPicker/PropertyPicker.js';
export { DatePicker } from './components/DatePicker/DatePicker.js';
export type { DatePickerProps } from './components/DatePicker/DatePicker.js';
export { GroupHeader } from './components/GroupHeader/GroupHeader.js';
export type { GroupHeaderProps } from './components/GroupHeader/GroupHeader.js';
export { IssueRow } from './components/IssueRow/IssueRow.js';
export type { IssueRowProperty, IssueRowProps } from './components/IssueRow/IssueRow.js';
export { EditableTitle, TITLE_MAX_LENGTH } from './components/EditableTitle/EditableTitle.js';
export type { EditableTitleProps } from './components/EditableTitle/EditableTitle.js';
export { VirtualList } from './components/VirtualList/VirtualList.js';
export type {
  VirtualItemProps,
  VirtualListHandle,
  VirtualListProps,
} from './components/VirtualList/VirtualList.js';
export {
  GROUP_HEADER_HEIGHT,
  ROW_HEIGHT,
  ROW_HEIGHT_COMPACT,
} from './components/VirtualList/window.js';

// Reactions and the emoji picker (PLAN-013 S4)
export { EmojiPicker } from './components/EmojiPicker/EmojiPicker.js';
export type { EmojiPickerProps, PickerEmoji } from './components/EmojiPicker/EmojiPicker.js';
export { FREQUENT_STORAGE_KEY } from './components/EmojiPicker/model.js';
export {
  ReactionChips,
  ReactionRow,
  reactionChipLabel,
  reactionTooltip,
} from './components/ReactionChips/ReactionChips.js';
export type {
  ReactionChipData,
  ReactionChipsProps,
  ReactionRowProps,
} from './components/ReactionChips/ReactionChips.js';
