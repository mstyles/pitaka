// The app's icons. This is the only file that imports lucide-react: to add
// an icon, re-export it here through `appIcon` under the app's own name,
// so a Lucide rename is fixed in one place and every icon keeps the 1.6
// stroke and `aria-hidden`.
import {
  Archive,
  ArchiveRestore,
  Bookmark,
  BookPlus,
  Check,
  CircleAlert,
  FolderInput,
  Highlighter,
  House,
  LibraryBig,
  type LucideIcon,
  type LucideProps,
  PenLine,
  Search,
  X,
} from "lucide-react";

function appIcon(Glyph: LucideIcon) {
  return function AppIcon({ size = 18, className, ...rest }: LucideProps) {
    return (
      <Glyph
        size={size}
        strokeWidth={1.6}
        aria-hidden="true"
        className={className ? `icon ${className}` : "icon"}
        {...rest}
      />
    );
  };
}

export const BooksIcon = appIcon(LibraryBig);
export const BookmarkIcon = appIcon(Bookmark);
export const SearchIcon = appIcon(Search);
export const PenIcon = appIcon(PenLine);
export const HomeIcon = appIcon(House);
export const HighlightIcon = appIcon(Highlighter);
export const ImportIcon = appIcon(BookPlus);
export const FolderIcon = appIcon(FolderInput);
export const BackupIcon = appIcon(Archive);
export const RestoreIcon = appIcon(ArchiveRestore);
export const CheckIcon = appIcon(Check);
export const AlertIcon = appIcon(CircleAlert);
export const XIcon = appIcon(X);
