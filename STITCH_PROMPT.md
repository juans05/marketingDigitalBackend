# Prompt para Google Stitch - Diseño UI/UX: Vidalis + Repurposer

Copia y pega esto en Google Stitch:

---

## PROYECTO: DOS PLATAFORMAS SAAS INDEPENDIENTES

You are a professional product designer tasked with creating high-fidelity UI/UX designs for two separate SaaS platforms that share a backend but have completely independent frontends and user experiences.

### PLATFORM 1: VIDALIS (vidalis.com)

**Purpose:** Full-featured social media management platform for marketing teams and agencies

**Target Users:** 
- Marketing managers
- Social media teams
- Agency creatives
- Team leaders who manage multiple accounts

**Key Features:**
1. Dashboard - Overview of all social networks, engagement, team activity
2. Content Calendar - Monthly/weekly view of scheduled posts across platforms
3. Content Creator - Rich editor for creating posts with media uploads
4. Social Accounts - Connect and manage multiple social media accounts
5. Publishing Queue - View, edit, and manage scheduled posts
6. Analytics - Performance metrics by platform and time period
7. Team Settings - Team management, billing, roles

**Design Approach:**
- **Aesthetic:** Professional, corporate, trustworthy
- **Color Scheme:** Dark mode primary with blue/teal accents
  - Primary: #2563EB (blue)
  - Dark: #1E293B (slate)
  - Success: #10B981 (green)
  - Warning: #F59E0B (amber)
- **Navigation:** Left sidebar + top bar (similar to Hootsuite, Buffer, Later)
- **Key Principle:** Efficiency, power user features, team collaboration
- **Workflow:** Bulk operations, scheduling, delegation

---

### PLATFORM 2: REPURPOSER (repurposer.com)

**Purpose:** Simplified AI-powered video repurposing tool for individual content creators

**Target Users:**
- Podcasters
- Content creators
- Streamers
- Conference speakers
- Solo content makers

**Key Features:**
1. Upload - Drag & drop video upload with progress tracking
2. AI Analysis - Show upload progress and processing status
3. Clip Gallery - Preview auto-generated clips in grid format
4. Platform Selector - Choose which networks to publish to
5. Publishing - Schedule or publish immediately
6. Performance - View metrics for each clip (views, likes, shares)
7. Account - Profile, subscription, help

**Design Approach:**
- **Aesthetic:** Modern, minimal, playful, creator-friendly
- **Color Scheme:** Light theme with vibrant accent colors
  - Primary: #7C3AED (purple)
  - Accent: #EC4899 (pink/orange gradient)
  - Light: #FFFFFF, #F3F4F6
  - Success: #10B981 (green)
- **Navigation:** Minimal navigation, wizard-style workflow (similar to Descript, CapCut Pro)
- **Key Principle:** Speed, simplicity, immediate feedback
- **Workflow:** Upload → Analyze → Preview → Publish (4-5 steps max)

---

## CRITICAL DESIGN DIFFERENCES

| Aspect | Vidalis | Repurposer |
|--------|---------|-----------|
| Theme | Dark mode (professional) | Light mode (approachable) |
| Primary Color | Blue (#2563EB) | Purple (#7C3AED) |
| Navigation | Left sidebar + top bar | Minimal, contextual |
| Complexity | High (many features) | Low (streamlined) |
| Density | Information-rich | Spacious, breathing room |
| Icons | Solid, professional | Clean, minimal |
| Tone | "Empower your team" | "Create & share effortlessly" |

---

## DESIGN SYSTEM (Shared across both)

### Typography
- **Headings:** Inter Bold (24px H1, 20px H2, 16px H3)
- **Body:** Inter Regular (14px, line-height 1.6)
- **Labels:** Inter Medium (12px, uppercase)
- **Code/Data:** JetBrains Mono (13px)

### Spacing
- Base unit: 8px
- Padding: 8px, 16px, 24px, 32px
- Margins: 16px, 24px, 32px, 40px

### Rounded Corners
- Inputs: 4px
- Cards: 8px
- Buttons: 6px
- Large components: 12px

### Shadows
- Light: rgba(0,0,0,0.04) 0px 2px 4px
- Medium: rgba(0,0,0,0.08) 0px 4px 8px
- Dark: rgba(0,0,0,0.12) 0px 8px 16px

### Components (Consistent)
- Buttons (Primary, Secondary, Tertiary, Danger)
- Cards with consistent styling
- Input fields with focus states
- Badge/tag components
- Modal dialogs
- Alerts & toasts
- Progress indicators

---

## VIDALIS SCREENS (7 screens + mobile variants)

### Screen 1: Login / Authentication
- Email/password login form
- "Sign up" link
- Forgot password link
- OAuth social login buttons (optional)
- Company branding

### Screen 2: Dashboard
- Top navigation bar (logo, notifications, user menu)
- Left sidebar (Dashboard, Calendar, Analytics, Settings)
- Main content area:
  - **Stats row:** Posts published (this week), total reach, engagement rate, team members active
  - **Social network cards** (grid of 2-3 columns):
    - Each card shows platform logo, account username
    - Follower count, last post thumbnail
    - Quick stats (views, engagement)
    - Action buttons (manage, view analytics)
  - **Recent activity feed** (Last 5 posts with status)
  - **CTA button:** "Create New Post" (prominent)

### Screen 3: Content Calendar
- Left: Mini calendar (month picker)
- Center: Large calendar view (month/week/day toggle)
  - Posts appear as colored dots (blue=TikTok, pink=Instagram, red=YouTube, black=Twitter)
  - Click on date to see posts scheduled that day
- Right sidebar (when post selected):
  - Post details (title, description, platforms, scheduled time)
  - Edit/delete/view buttons

### Screen 4: Content Creator
- Two-column layout:
  - **Left (70%):** Rich text editor
    - Title input
    - Content textarea with formatting toolbar (bold, italic, link, etc.)
    - Media uploader (images, videos, links)
    - Preview of media attached
  - **Right (30%):** Platform preview panel
    - Tabs: TikTok preview, Instagram preview, YouTube preview, Twitter preview
    - Shows how post looks on each network
    - Aspect ratio warnings

### Screen 5: Social Accounts Manager
- Account list (table format):
  - Columns: Platform logo, account name, followers, status (connected/disconnected), last sync, actions
  - Each row expandable to show credentials status
  - Add account button at top
- Disconnect button per account
- Refresh credentials button

### Screen 6: Publishing Queue
- Table of scheduled posts:
  - Columns: Thumbnail, Title, Platforms, Scheduled time, Status (pending/published), Actions
  - Status badges (color coded)
  - Bulk actions (publish now, reschedule, delete)
  - Filter by platform, date range, status
- Pagination (show 20 per page)

### Screen 7: Analytics Dashboard
- Date range picker (top right)
- Tabs: Overview, By Platform, By Content Type
- Charts:
  - Line chart: Engagement over time
  - Bar chart: Performance by platform
  - Table: Top 10 posts by engagement
- Export button (CSV, PDF)

---

## REPURPOSER SCREENS (7 screens + mobile variants)

### Screen 1: Login / Authentication
- Minimal login form (email/password)
- "Create account" link
- OAuth option (optional)
- Light theme, simple branding

### Screen 2: Upload Video
- Full-screen centered upload area
- Large drop zone with:
  - Upload icon (video play symbol)
  - Text: "Drop your video here or click to browse"
  - Supported formats: MP4, MOV, WebM (max 2 hours)
- Browse button
- Recent videos list (thumbnails below upload area)
- Pricing reminder: "Free users: 1 video/month, Creator plan: 5/month"

### Screen 3: Processing Status
- Centered progress indicator:
  - Large spinner (rotating gradient)
  - Current step message:
    - "Uploading video... 45%"
    - "Analyzing content..."
    - "Detecting segments..."
    - "Generating clips..."
  - Estimated time remaining (e.g., "~2 minutes remaining")
- Cancel button
- Don't close tab warning message

### Screen 4: Clip Gallery
- Clips are sorted by viral score, highest first (this ranking is the point of the screen: tell the user which clip is best)
- Top clip gets a distinct "Best Pick" / "Recomendado" badge/ribbon on its card, visually separated from the rest (e.g. highlighted border or its own row above the grid)
- Grid of clip cards (2-3 columns, responsive):
  - Each card shows:
    - Thumbnail (frame from clip)
    - Duration badge (0:15, 0:30, etc.)
    - Viral score badge (circular progress, color coded: green=80+, amber=50-79, gray=<50)
    - Platform icons checkboxes (TikTok, IG, YouTube, Twitter)
    - Action buttons: Preview (eye), Edit (pencil), Delete (trash)
- Top filters:
  - Viral score slider (0-100)
  - Duration range (0-60 sec)
  - Platform filter (multi-select)
- "Select All" / "Publish Selected" buttons at bottom

### Screen 5: Clip Preview & Editor
- Three-column layout:
  - **Left (50%):** Video player
    - Shows clip with player controls
    - Timeline scrubber
    - Start/end time display (e.g., "0:15 - 0:30")
  - **Middle (25%):** Platform previews (tabs)
    - TikTok tab: 9:16 aspect ratio preview
    - Instagram tab: 9:16 with story frame
    - YouTube tab: 16:9 preview
    - Twitter tab: 16:9 preview
  - **Right (25%):** Clip editor
    - Viral score gauge (circular progress)
    - Metadata:
      - Title input
      - Description textarea
      - Tags input
    - Edit buttons:
      - Trim (adjust start/end)
      - Captions (toggle on/off)
      - Watermark (customization options)
      - Color adjust (brightness/contrast sliders)
    - Platform selector (checkboxes)
    - "Publish" button (large, primary CTA)

### Screen 6: Publishing Confirmation
- Modal dialog: "Publish to Social Media"
- Platform checklist:
  - [ ] TikTok
  - [ ] Instagram
  - [ ] YouTube
  - [ ] Twitter
- Scheduling options:
  - Radio: "Publish now" (default) OR "Schedule for later"
  - If scheduled: datetime picker + timezone selector
- Caption review (one caption field per platform)
- "Back" and "Publish" buttons

### Screen 7: Performance Dashboard
- Date range picker (Last 7 days, 30 days, All time)
- Top stats row (large numbers):
  - Total views | Total likes | Total shares | Avg engagement %
- Clips performance table:
  - Columns: Thumbnail, Duration, Platform, Views, Likes, Shares, Engagement %, Date published
  - Sortable by any column
  - Color-coded engagement rates
- Line chart: Views over time (selectable by platform)
- "Export as CSV" button

---

## RESPONSIVE DESIGN

**Breakpoints:**
- Mobile: < 640px
- Tablet: 640px - 1024px
- Desktop: > 1024px

**Vidalis Mobile:**
- Hamburger menu (sidebar collapses)
- Single column layout
- Cards stack vertically
- Reduced data density

**Repurposer Mobile:**
- Full-screen focused experience
- Vertical scrolling
- Large touch targets
- Simplified controls
- Optimized for portrait orientation

---

## ANIMATIONS & INTERACTIONS

**Upload Progress:**
- Animated gradient spinner
- Progress bar filling (linear animation)
- Smooth state transitions between upload steps

**Clip Generation:**
- Cards fade in with slight scale animation
- Stagger effect (each card appears 100ms apart)
- Smooth transitions

**Publishing:**
- Success animation: Checkmark appears, brief celebration (subtle confetti effect)
- Toast notifications: Slide in from top/bottom

**Hover Effects:**
- Buttons: Brightness increase (+10%), shadow enhancement
- Cards: Lift (shadow increases), slight scale (1.02x)
- Links: Underline appears, color change

**Loading States:**
- Skeleton loaders (pulsing gray blocks)
- Animated spinners (gradient-based)
- Progress bars with striped pattern

---

## DELIVERABLES NEEDED

1. **Design System Document**
   - Color palette with hex codes
   - Typography scale (all sizes and weights)
   - Component library (buttons, cards, inputs, badges, modals)
   - Spacing/sizing guide
   - Shadow/elevation system

2. **Vidalis Screens**
   - 7 desktop screens at 1920x1080 resolution
   - Mobile variants for key screens (375x667)
   - Tablet variant for calendar (1024x768)
   - Fully annotated (spacing, colors, states)

3. **Repurposer Screens**
   - 7 desktop screens at 1920x1080 resolution
   - Mobile-first variants (375x667) for all screens
   - Fully annotated

4. **Interactive Prototypes**
   - Vidalis: Dashboard → Create → Calendar → Publish flow
   - Repurposer: Upload → Analyze → Gallery → Preview → Publish flow
   - Clickable transitions between screens

5. **Component Library Export**
   - Figma file with organized component library
   - Each component in all states (default, hover, active, disabled, error)
   - Spacing and sizing specifications on each component

6. **Interaction Specifications**
   - Document describing all interactions
   - Animation durations and easing curves
   - Hover states, active states, disabled states
   - Error states and validation messages

7. **Icon Set**
   - All custom icons as SVG/PNG exports
   - Consistent style, 24px and 32px variants
   - Used throughout both products

---

## KEY DESIGN PRINCIPLES

1. **Vidalis = Power User:** Information-dense, efficient, bulk operations
   - Show more data per screen
   - Keyboard shortcuts friendly
   - Advanced filtering and sorting
   - Team collaboration features

2. **Repurposer = Creator:** Simple, fast, beautiful
   - Minimal decision points
   - Immediate feedback
   - Celebrate success (published!)
   - Hide technical complexity

3. **Consistency:** Shared design system for both
   - Same typography, spacing, shadows
   - Similar component library
   - Cohesive visual language
   - But different color themes per product

4. **Accessibility:** WCAG 2.1 AA minimum
   - Color contrast ratios met
   - Keyboard navigation (Tab, Enter, Escape)
   - Screen reader friendly (labels, ARIA)
   - Focus indicators visible

---

## TONE & VOICE

### Vidalis Copy
- Professional, empowering, efficient
- Examples:
  - "Manage all your social content in one place"
  - "Publish to 4 platforms simultaneously"
  - "Scale your team's social presence"
  - Button labels: "Create Post", "Schedule Now", "View Analytics"

### Repurposer Copy
- Friendly, encouraging, playful
- Examples:
  - "Transform long videos into viral clips"
  - "AI-powered video repurposing"
  - "Your podcast deserves clips 🎬"
  - Button labels: "Upload Video", "Generate Clips", "Publish Now"

---

## TECHNICAL REQUIREMENTS FOR DEVELOPERS

- Export in Figma format (organized components layer structure)
- Include all spacing and sizing as measurements
- Export all colors as CSS variables
- Provide interaction specs with animation timings (duration, easing)
- All custom icons as SVG files
- Document all states: default, hover, active, disabled, error, loading
- Provide color tokens for both light and dark themes (even though Repurposer is light)
- Include responsive design breakpoints

---

## START WITH

1. Design system first (colors, typography, components)
2. Vidalis Dashboard (most complex screen)
3. Repurposer Upload Flow (simplest flow)
4. Remaining screens per platform
5. Interactive prototypes showing core flows
6. Mobile variants

**IMPORTANT:** Keep Vidalis dark/professional and Repurposer light/playful. They should look like completely different products, even though they share design tokens.

---

Fin del prompt para Stitch
