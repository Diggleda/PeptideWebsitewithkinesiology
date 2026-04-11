import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import { Textarea } from './ui/textarea';
import { Loader2, Trash2, Upload } from 'lucide-react';
import { toast } from '../lib/toast';

export interface DoctorProfileUser {
  name?: string | null;
  email?: string | null;
  profileImageUrl?: string | null;
  greaterArea?: string | null;
  studyFocus?: string | null;
  bio?: string | null;
  networkPresenceAgreement?: boolean;
}

export interface DoctorProfilePayload {
  name: string;
  email: string;
  profileImageUrl: string | null;
  greaterArea: string | null;
  studyFocus: string | null;
  bio: string | null;
  networkPresenceAgreement: boolean;
}

interface DoctorProfileFormProps {
  user: DoctorProfileUser | null;
  title?: ReactNode;
  description?: ReactNode;
  preActionsNote?: ReactNode;
  avatarStyle?: 'default' | 'compact-circle';
  submitLabel?: string;
  submittingLabel?: string;
  skipLabel?: string;
  bioSectionClassName?: string;
  onSubmit: (payload: DoctorProfilePayload) => Promise<void>;
  onSkip?: () => void;
}

const compressImageToDataUrl = (file: File, opts?: { maxSize?: number; quality?: number }): Promise<string> => {
  const maxSize = opts?.maxSize ?? 1600;
  const quality = opts?.quality ?? 0.82;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result || '');
      const img = new Image();
      img.onload = () => {
        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;
        if (!width || !height) {
          reject(new Error('IMAGE_DIMENSIONS_INVALID'));
          return;
        }
        const scale = Math.min(1, maxSize / width, maxSize / height);
        const targetWidth = Math.max(1, Math.round(width * scale));
        const targetHeight = Math.max(1, Math.round(height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('CANVAS_CONTEXT_UNAVAILABLE'));
          return;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('IMAGE_LOAD_FAILED'));
      img.src = src;
    };
    reader.onerror = () => reject(new Error('FILE_READ_FAILED'));
    reader.readAsDataURL(file);
  });
};

const getInitials = (value?: string | null) => {
  const tokens = String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) {
    return 'DR';
  }
  return tokens.slice(0, 2).map((token) => token[0]?.toUpperCase() || '').join('') || 'DR';
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function DoctorProfileForm({
  user,
  title,
  description,
  preActionsNote,
  avatarStyle = 'default',
  submitLabel = 'Save profile',
  submittingLabel = 'Saving…',
  skipLabel = 'Skip for now',
  bioSectionClassName,
  onSubmit,
  onSkip,
}: DoctorProfileFormProps) {
  const isCompactCircleAvatar = avatarStyle === 'compact-circle';
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [greaterArea, setGreaterArea] = useState(user?.greaterArea || '');
  const [studyFocus, setStudyFocus] = useState(user?.studyFocus || '');
  const [bio, setBio] = useState(user?.bio || '');
  const [networkPresenceAgreement, setNetworkPresenceAgreement] = useState(
    user?.networkPresenceAgreement === true,
  );
  const [profileImageUrl, setProfileImageUrl] = useState<string | null>(user?.profileImageUrl ?? null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const avatarFrameClassName =
    isCompactCircleAvatar
      ? 'shrink-0 text-sm'
      : 'h-[72px] w-[72px] rounded-full text-lg';
  const avatarImageClassName =
    isCompactCircleAvatar
      ? ''
      : 'h-full w-full rounded-full object-cover';
  const avatarFrameStyle = isCompactCircleAvatar
    ? {
        width: '56px',
        height: '56px',
        minWidth: '56px',
        minHeight: '56px',
        maxWidth: '56px',
        maxHeight: '56px',
        borderRadius: '9999px',
      }
    : {
        width: '72px',
        height: '72px',
        minWidth: '72px',
        minHeight: '72px',
        maxWidth: '72px',
        maxHeight: '72px',
        borderRadius: '9999px',
      };
  const avatarImageStyle = isCompactCircleAvatar
    ? {
        width: '100%',
        height: '100%',
        minWidth: '100%',
        minHeight: '100%',
        maxWidth: '100%',
        maxHeight: '100%',
        objectFit: 'cover' as const,
        borderRadius: '9999px',
        display: 'block',
      }
    : {
        width: '100%',
        height: '100%',
        minWidth: '100%',
        minHeight: '100%',
        maxWidth: '100%',
        maxHeight: '100%',
        objectFit: 'cover' as const,
        borderRadius: '9999px',
        display: 'block',
      };
  const contentLayoutClassName = isCompactCircleAvatar
    ? 'space-y-4'
    : 'flex flex-col gap-6 sm:flex-row sm:items-start pt-2';
  const avatarPanelClassName = isCompactCircleAvatar
    ? 'flex items-center gap-3'
    : 'flex flex-col gap-3 sm:min-w-[220px] sm:max-w-[260px]';
  const avatarButtonClassName = isCompactCircleAvatar
    ? 'squircle-sm h-8 px-3 text-xs'
    : 'squircle-sm';
  const profileFieldClassName =
    'border-slate-200 text-slate-900 placeholder:text-slate-500';
  const profileTextareaClassName = `${profileFieldClassName} min-h-[9rem] resize-y`;
  const profileFieldStyle = {
    backgroundColor: 'rgb(241, 245, 249)',
    borderColor: 'rgb(203, 213, 225)',
  } satisfies React.CSSProperties;
  const bioSectionClasses = [
    isCompactCircleAvatar ? 'space-y-2 pt-4' : 'space-y-2 pt-2',
    bioSectionClassName,
  ].filter(Boolean).join(' ');

  useEffect(() => {
    setName(user?.name || '');
    setEmail(user?.email || '');
    setGreaterArea(user?.greaterArea || '');
    setStudyFocus(user?.studyFocus || '');
    setBio(user?.bio || '');
    setNetworkPresenceAgreement(user?.networkPresenceAgreement === true);
    setProfileImageUrl(user?.profileImageUrl ?? null);
    setError(null);
  }, [
    user?.name,
    user?.email,
    user?.greaterArea,
    user?.studyFocus,
    user?.bio,
    user?.networkPresenceAgreement,
    user?.profileImageUrl,
  ]);

  const validate = () => {
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const trimmedArea = greaterArea.trim();
    const trimmedFocus = studyFocus.trim();
    const trimmedBio = bio.trim();

    if (!trimmedName) {
      return 'Name is required.';
    }
    if (!trimmedEmail || !EMAIL_PATTERN.test(trimmedEmail)) {
      return 'Enter a valid email address.';
    }
    if (trimmedArea.length > 190) {
      return 'Greater area must be 190 characters or fewer.';
    }
    if (trimmedFocus.length > 190) {
      return 'Study focus must be 190 characters or fewer.';
    }
    if (trimmedBio.length > 1000) {
      return 'Bio must be 1000 characters or fewer.';
    }
    return null;
  };

  const handleAvatarFile = async (file: File | null) => {
    if (!file || avatarUploading) {
      return;
    }
    const maxBytes = 50 * 1024 * 1024;
    if (file.size > maxBytes) {
      toast.error('Upload too large. Please choose an image 50MB or smaller.');
      return;
    }
    if (!file.type || !file.type.startsWith('image/')) {
      toast.error('Please choose an image file.');
      return;
    }

    setAvatarUploading(true);
    try {
      const dataUrl = await compressImageToDataUrl(file, { maxSize: 1600, quality: 0.82 });
      try {
        const FaceDetectorCtor = (window as any)?.FaceDetector;
        if (FaceDetectorCtor) {
          const img = new Image();
          img.decoding = 'async';
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error('IMAGE_DECODE_FAILED'));
            img.src = dataUrl;
          });
          const detector = new FaceDetectorCtor({ fastMode: true, maxDetectedFaces: 3 });
          const faces = await detector.detect(img);
          if (!faces || faces.length === 0) {
            const proceed = window.confirm(
              'No face was detected in this image. If this is intentional, you can continue.\n\nContinue uploading?',
            );
            if (!proceed) {
              toast.error('Upload canceled.');
              return;
            }
          }
        }
      } catch {
        // Ignore client-side heuristics when unsupported.
      }

      try {
        const { moderationAPI } = await import('../services/api');
        const response = await moderationAPI.checkImage({ dataUrl, purpose: 'profile_photo' });
        if (response?.flagged) {
          const proceed = window.confirm(
            'This image may contain inappropriate content. Please choose a different image.\n\nContinue anyway?',
          );
          if (!proceed) {
            toast.error('Upload canceled.');
            return;
          }
        }
      } catch {
        // Soft-fail moderation if unavailable.
      }

      setProfileImageUrl(dataUrl);
    } catch {
      toast.error('Unable to process that image right now.');
    } finally {
      setAvatarUploading(false);
      if (avatarInputRef.current) {
        avatarInputRef.current.value = '';
      }
    }
  };

  const handleSubmit = async () => {
    if (saving) {
      return;
    }
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const trimmedArea = greaterArea.trim();
      const trimmedFocus = studyFocus.trim();
      const trimmedBio = bio.trim();
      await onSubmit({
        name: name.trim(),
        email: email.trim(),
        profileImageUrl,
        greaterArea: trimmedArea || null,
        studyFocus: trimmedFocus || null,
        bio: trimmedBio || null,
        networkPresenceAgreement,
      });
    } catch (submitError: any) {
      setError(
        typeof submitError?.message === 'string' && submitError.message.trim()
          ? submitError.message.trim()
          : 'Unable to save the physician profile right now.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {(title || description) && (
        <div className="space-y-0">
          {title && <div className="text-lg font-semibold text-slate-900">{title}</div>}
          {description && <div className="text-sm leading-5 text-slate-600">{description}</div>}
        </div>
      )}

      <div className={contentLayoutClassName}>
        <div className={avatarPanelClassName}>
          <div className={isCompactCircleAvatar ? undefined : 'space-y-2'}>
            {!isCompactCircleAvatar && (
              <p className="text-sm font-semibold text-slate-800">Profile photo</p>
            )}
            <div
              className={isCompactCircleAvatar ? undefined : 'avatar-shell'}
            >
              <div
                className={`flex items-center justify-center overflow-hidden border border-slate-200 bg-slate-50 font-semibold text-slate-500 shadow-sm ${avatarFrameClassName}`}
                style={avatarFrameStyle}
              >
                {profileImageUrl ? (
                  <img
                    src={profileImageUrl}
                    alt={`${name.trim() || user?.name || 'Physician'} profile`}
                    className={avatarImageClassName}
                    style={avatarImageStyle}
                  />
                ) : (
                  <span>{getInitials(name || user?.name)}</span>
                )}
              </div>
            </div>
          </div>
          <div className={isCompactCircleAvatar ? 'flex flex-wrap items-center gap-2' : 'space-y-2'}>
            <div className={isCompactCircleAvatar ? undefined : 'flex items-center gap-3 flex-wrap'}>
              <Button
                type="button"
                variant="outline"
                className={avatarButtonClassName}
                disabled={avatarUploading || saving}
                onClick={() => avatarInputRef.current?.click()}
              >
                {avatarUploading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Uploading…
                  </>
                ) : (
                  <>
                    <Upload className="mr-2 h-4 w-4" />
                    Upload photo
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className={`${avatarButtonClassName} text-slate-700`}
                disabled={avatarUploading || saving || !profileImageUrl}
                onClick={() => setProfileImageUrl(null)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Remove
              </Button>
            </div>
            {!isCompactCircleAvatar && (
              <p className="text-xs text-slate-500">
                Photos must be 50MB or smaller in size. Profile photo is optional.
              </p>
            )}
          </div>
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              void handleAvatarFile(event.target.files?.[0] || null);
            }}
          />
        </div>

        <div className="flex-1 space-y-3">
          <div className="flex items-center gap-4 py-1">
            <Switch
              id="physician-profile-network-presence"
              checked={networkPresenceAgreement}
              onCheckedChange={setNetworkPresenceAgreement}
              disabled={saving}
              aria-label="Allow this profile to be presented as a physician in the network"
            />
            <div className="min-w-0">
              <Label htmlFor="physician-profile-network-presence" className="leading-6">
                Allow this profile to be presented as a physician in the network
              </Label>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="physician-profile-name">Name</Label>
              <Input
                id="physician-profile-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
                disabled={saving}
                className={profileFieldClassName}
                style={profileFieldStyle}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="physician-profile-email">Email</Label>
              <Input
                id="physician-profile-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                disabled={saving}
                className={profileFieldClassName}
                style={profileFieldStyle}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="physician-profile-area">Greater Area</Label>
              <Input
                id="physician-profile-area"
                value={greaterArea}
                onChange={(event) => setGreaterArea(event.target.value)}
                placeholder="e.g. Greater Chicago Area"
                maxLength={190}
                disabled={saving}
                className={profileFieldClassName}
                style={profileFieldStyle}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="physician-profile-focus">Study Focus</Label>
              <Input
                id="physician-profile-focus"
                value={studyFocus}
                onChange={(event) => setStudyFocus(event.target.value)}
                placeholder="e.g. metabolic response and recovery"
                maxLength={190}
                disabled={saving}
                className={profileFieldClassName}
                style={profileFieldStyle}
              />
            </div>
          </div>
        </div>
      </div>

      <div className={bioSectionClasses}>
        <Label htmlFor="physician-profile-bio">Bio</Label>
        <Textarea
          id="physician-profile-bio"
          value={bio}
          onChange={(event) => setBio(event.target.value)}
          rows={5}
          maxLength={1000}
          disabled={saving}
          placeholder="Share a short professional bio for your research platform profile."
          className={profileTextareaClassName}
          style={profileFieldStyle}
        />
        <div className="text-right text-xs text-slate-500">{bio.trim().length}/1000</div>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}

      {preActionsNote && (
        <div className="py-2 text-sm leading-6 text-slate-600">
          {preActionsNote}
        </div>
      )}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        {onSkip && (
          <Button
            type="button"
            variant="outline"
            className="border-slate-300 bg-white text-slate-900"
            disabled={saving || avatarUploading}
            onClick={onSkip}
          >
            {skipLabel}
          </Button>
        )}
        <Button
          type="button"
          className="header-home-button min-w-[220px]"
          disabled={saving || avatarUploading}
          onClick={() => void handleSubmit()}
        >
          {saving ? submittingLabel : submitLabel}
        </Button>
      </div>
    </div>
  );
}
