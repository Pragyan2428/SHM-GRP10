import { Suspense, lazy, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity, ArrowRight, BatteryCharging, Box, Bell, CircleDollarSign, Cloud, Cpu, Gauge, History, IndianRupee,
  Layers, LayoutDashboard, Mail, MessageCircle, MonitorSmartphone, Puzzle, Radio, ShieldAlert, Sparkles, Thermometer, Users, Waves, Wifi,
  Wrench,
} from 'lucide-react'
import ExplodedNode from '../components/ExplodedNode'
import { BrandMark } from '../components/Layout'
import ScrollTop from '../components/ScrollTop'
import ShmBackdrop from '../components/ShmBackdrop'
import NodeViewer from '../components/NodeViewer'
import { useAuth } from '../lib/context'

// three.js is only downloaded when the About page is opened.
const Node3D = lazy(() => import('../components/Node3D'))

// Same order the 3D model comes apart in (kept here so the chips render before three.js loads).
const NODE_PARTS = [
  { key: 'lid', name: 'Lid' }, { key: 'ds18b20', name: 'DS18B20' }, { key: 'adxl345', name: 'ADXL345' },
  { key: 'hx711', name: 'HX711' }, { key: 'esp32', name: 'ESP32' }, { key: 'battery', name: 'Battery' }, { key: 'base', name: 'Base' },
]

// Content of the Group 10 project presentation (EPD HS30223), adapted for the web.
const TEAM = [
  { name: 'Laksha Mandiye', roll: '2430039' },
  { name: 'Pragyan Singh', roll: '2430048' },
  { name: 'Pranjal Gurnule', roll: '2430049' },
  { name: 'Kamayani Sinha', roll: '2430160' },
]

const PROBLEMS = [
  { icon: Wrench, title: 'Manual & expensive', text: 'Periodic inspections need specialised personnel and equipment, driving up operating costs.' },
  { icon: History, title: 'Reactive approach', text: 'Damage is found only once it is visible, far too late for cost-effective repair.' },
  { icon: ShieldAlert, title: 'Safety risks', text: 'Undetected deterioration can lead to structural failure, endangering lives and property.' },
  { icon: CircleDollarSign, title: 'High maintenance costs', text: 'Emergency repairs cost far more than preventive maintenance would have.' },
]

const SOLUTION = [
  { icon: Radio, title: 'Wireless sensor nodes', text: 'Strain, vibration and temperature measured at several points of the structure.' },
  { icon: Cpu, title: 'Real-time processing', text: 'An ESP32 microcontroller on each node reads and checks the data at the edge.' },
  { icon: Cloud, title: 'Cloud connectivity', text: 'Readings travel over Wi-Fi to a cloud database for persistent storage.' },
  { icon: Bell, title: 'Automated alerts & dashboard', text: 'Instant notifications on anomalies, live visualisation and a full history log.' },
]

const COMPONENTS = [
  { icon: Waves, name: 'HX711', role: 'Strain gauge amplifier', measures: 'Strain (με)' },
  { icon: Activity, name: 'ADXL345', role: '3-axis accelerometer', measures: 'Vibration (g)' },
  { icon: Thermometer, name: 'DS18B20', role: 'Digital temperature sensor', measures: 'Temperature (°C)' },
  { icon: Cpu, name: 'ESP32', role: 'Dual-core, Wi-Fi, low power', measures: 'Reads sensors, sends data' },
]

const INNOVATIONS = [
  { icon: IndianRupee, title: 'Affordable', text: '70% cost reduction compared with conventional industrial SHM solutions.' },
  { icon: Wifi, title: 'Compact & wireless', text: 'Easy installation with no extensive cabling or infrastructure.' },
  { icon: Puzzle, title: 'Modular design', text: 'Expandable to more sensors and monitoring points as needs grow.' },
  { icon: Cloud, title: 'Cloud-based', text: 'Accessible from anywhere and scalable to many buildings at once.' },
  { icon: Sparkles, title: 'AI-ready', text: 'A solid foundation for predictive maintenance algorithms.' },
]

const COMPARISON = [
  ['Cost', 'High (personnel + equipment)', 'Very high', 'Low (70% savings)'],
  ['Monitoring mode', 'Periodic only', 'Continuous', 'Continuous'],
  ['Approach', 'Reactive', 'Proactive', 'Proactive'],
  ['Real-time data', 'None', 'Yes', 'Yes'],
  ['Installation', 'N/A', 'Complex', 'Simple & wireless'],
  ['Scalability', 'Limited', 'Limited', 'Highly scalable'],
]

const TIMELINE = [
  { month: 'Month 1', text: 'Component procurement and circuit design' },
  { month: 'Month 2', text: 'Firmware, cloud dashboard and proof-of-concept validation (Week 8)' },
  { month: 'Month 3', text: 'PCB design, battery optimisation, multi-node communication' },
  { month: 'Month 4', text: 'Performance testing, final validation and MVP release (Week 16)' },
]

// Photo rows inside the sections: [file, caption title, caption text, alt, crop position]
const HARDWARE_PHOTOS = [
  ['hw-esp32', 'ESP32 dev board', 'The brain of every node: reads the sensors and sends over Wi-Fi.', 'An ESP32 development board on a dark desk'],
  ['hw-adxl', '3-axis accelerometer module', 'Feels the vibration of a beam or column, the job the ADXL345 does in our node.', 'A small blue accelerometer breakout board next to header pins'],
]
const WHY_PHOTOS = [
  ['why-arch', 'Old structures age quietly', 'Brick and stone keep weathering long after anyone last checked them.', 'An old brick arch bridge over a dry stream'],
  ['why-netting', 'Inspection is slow and manual', 'Engineers still walk every span; our nodes watch it all the time.', 'A man walking on safety netting under a steel bridge deck'],
]
const TIMELINE_PHOTOS = [
  ['timeline-solder', 'Phase 1 · build it', 'Soldering the sensors to the ESP32 and writing the first firmware.', 'Hands soldering a small green circuit board next to a laptop', 'center 72%'],
  ['timeline-bench', 'Phase 2 · make it last', 'Custom PCB, power tuning and testing many nodes together.', 'An electronics workbench with circuit boards and precision tools'],
]
const SERVE_PHOTOS = [
  ['serve-flyover', 'Flyovers & interchanges', 'Heavy daily traffic, constant vibration.', 'Aerial view of a multi-level highway interchange'],
  ['serve-housing', 'Ageing apartment blocks', 'Older homes where cracks matter most.', 'An old multi-storey residential building with balconies'],
  ['serve-steel-bridge', 'Steel & rail bridges', 'Riveted trusses under load, rain and heat.', 'A steel truss bridge walkway in fog and rain'],
]

function PhotoRow({ items, testid }) {
  return (
    <div className={`about-photos n${items.length}`} data-testid={testid}>
      {items.map(([file, title, text, alt, pos]) => (
        <figure key={file} className="about-photo">
          <img src={`/images/${file}.webp`} alt={alt} loading="lazy" decoding="async" style={pos ? { objectPosition: pos } : undefined} />
          <figcaption><strong>{title}</strong><span>{text}</span></figcaption>
        </figure>
      ))}
    </div>
  )
}

const MARKET = ['Building owners and facility managers', 'Civil engineers and structural consultants', 'Construction companies',
  'Government infrastructure departments', 'Smart city and urban development projects']

const OUTCOMES = [
  { title: 'Platform', text: 'Wireless monitoring with a real-time dashboard and automated alerts.' },
  { title: 'Safety', text: 'Early crack detection, reduced downtime and improved structural safety.' },
  { title: 'Future', text: 'Expandable multi-sensor architecture ready for predictive-maintenance AI.' },
]

const IN_THIS_APP = [
  { icon: LayoutDashboard, title: 'Real-time dashboard', text: 'Overview and Live telemetry refresh every 5 seconds, with the building map.' },
  { icon: History, title: 'Historical logging', text: 'Every reading and alert is stored; filter it and export CSV.' },
  { icon: Mail, title: 'Automated alerts', text: 'Email (Gmail), WhatsApp, SMS and browser notifications when a limit is crossed.' },
  { icon: Gauge, title: 'Configurable limits', text: 'Warning, safe and critical levels per sensor, with early warnings on rising trends.' },
  { icon: Layers, title: 'Multi-node', text: 'Any number of ESP32 nodes; each registers itself on its first reading.' },
  { icon: Users, title: 'Admin & user access', text: 'Admins manage the system; users sign up with Gmail and see the live readings.' },
]

function Cards({ items, testid }) {
  return (
    <div className="about-cards" data-testid={testid}>
      {items.map(({ icon: Icon, title, text }) => (
        <div key={title} className="about-card">
          {Icon ? <Icon size={18} className="about-icon" aria-hidden="true" /> : null}
          <h3>{title}</h3>
          <p>{text}</p>
        </div>
      ))}
    </div>
  )
}

function Section({ id, eyebrow, title, children }) {
  return (
    <section className="about-section" aria-labelledby={id} data-testid={`about-${id}`}>
      <div className="about-eyebrow">{eyebrow}</div>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  )
}

export default function About() {
  const { user } = useAuth()
  const home = user ? (user.role === 'admin' ? '/' : '/user') : null
  const scrollyRef = useRef(null)
  const [revealed, setRevealed] = useState([])
  const [viewing, setViewing] = useState(false)
  const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  return (
    <div className="about-page" data-testid="about-page">
      <ShmBackdrop />
      <div className="about-hero-wrap">
        <header className="about-nav">
          <Link to="/about" className="about-brand"><BrandMark /><span className="brand-name">Smart <span>SHM</span></span></Link>
          <nav className="about-links" aria-label="Sections">
            {[['problem', 'Problem'], ['solution', 'Solution'], ['hardware', 'Hardware'], ['workflow', 'Timeline'], ['team', 'Team']].map(([id, label]) => (
              <a key={id} href={`#${id}`}>{label}</a>
            ))}
          </nav>
          <div className="about-actions">
            {home ? (
              <Link to={home} className="btn btn-pill about-outline" data-testid="about-open-app-link">
                Open {user.role === 'admin' ? 'dashboard' : 'readings'}
              </Link>
            ) : (
              <>
                <Link to="/login" className="btn btn-pill about-outline" data-testid="about-login-link">Login</Link>
                <Link to="/signup" className="btn btn-pill btn-accent" data-testid="about-signup-link">Sign up</Link>
              </>
            )}
          </div>
        </header>

        {/* Tall section: while it scrolls past, the stage stays pinned and the 3D node comes apart. */}
        <section className={`about-scrolly ${reduceMotion ? 'static' : ''}`} ref={scrollyRef} aria-labelledby="about-title" data-testid="about-scrolly">
          <div className="about-hero scrolly-stage">
            <div className="about-hero-text">
              <div className="about-eyebrow">Electronics Product Development (EPD) · HS30223 · Group 10</div>
              <h1 id="about-title" data-testid="about-title">Smart Structural Health Monitoring System</h1>
              <p className="about-lead">
                Continuous monitoring enables early detection, improving safety while significantly reducing maintenance costs.
                Wireless ESP32 sensor nodes measure strain, vibration and temperature, send them to the cloud over Wi-Fi,
                and raise alerts the moment a structure needs attention.
              </p>
              <div className="row" style={{ gap: 12 }}>
                <Link to={home || '/login'} className="btn btn-pill btn-accent about-cta-btn">
                  {home ? `Open ${user.role === 'admin' ? 'dashboard' : 'readings'}` : 'Open the live dashboard'}
                </Link>
                <button type="button" className="btn btn-pill about-outline about-view-3d" onClick={() => setViewing(true)} data-testid="about-view-3d">
                  <Box size={15} aria-hidden="true" /> View the 3D model
                </button>
                <a href="#hardware" className="about-text-link">See the hardware ↓</a>
              </div>
              <div className="parts-progress" data-testid="parts-progress">
                <div className="parts-hint">{revealed.length ? `${revealed.length} of ${NODE_PARTS.length} parts revealed` : 'Scroll to take the sensor node apart ↓'}</div>
                <div className="parts-chips">
                  {NODE_PARTS.map((p) => (
                    <span key={p.key} className={`part-chip ${revealed.includes(p.key) ? 'on' : ''}`} data-testid={`part-chip-${p.key}`}>{p.name}</span>
                  ))}
                </div>
              </div>
            </div>
            <div className="about-hero-art">
              <Suspense fallback={<ExplodedNode />}>
                <Node3D sectionRef={scrollyRef} onReveal={setRevealed} fallback={<ExplodedNode />} />
              </Suspense>
            </div>
          </div>
        </section>
      </div>

      <main className="about-content">
        <section className="about-section" aria-labelledby="team" data-testid="about-team-section">
          <div className="about-eyebrow">Group 10</div>
          <h2 id="team">The team</h2>
          <div className="about-team" data-testid="about-team">
            {TEAM.map((m) => (
              <div key={m.roll} className="about-member">
                <span className="about-avatar" aria-hidden="true">{m.name.split(' ').map((w) => w[0]).join('')}</span>
                <span><strong>{m.name}</strong><span className="xs dim mono">{m.roll}</span></span>
              </div>
            ))}
          </div>
        </section>

        <Section id="problem" eyebrow="The problem" title="Current structural inspections fall short">
          <Cards items={PROBLEMS} testid="about-problem-cards" />
        </Section>

        <figure className="about-banner" data-testid="about-banner">
          <img src="/images/about-city.webp" alt="Aerial render of a glass-and-brick building among white city blocks" loading="lazy" decoding="async" width="736" height="1308" />
          <figcaption>
            <span className="about-eyebrow">Built for real buildings</span>
            <strong>Every floor, every column, watched in real time.</strong>
            <span>Small ESP32 nodes on beams and columns send strain, vibration and temperature to one dashboard.</span>
          </figcaption>
        </figure>

        <Section id="solution" eyebrow="Proposed solution" title="What the Smart SHM system does">
          <div className="about-split">
            <div className="about-split-media">
              <img className="about-split-img" src="/images/about-concrete.webp" alt="Concrete floors cantilevered over a column" loading="lazy" decoding="async" width="736" height="1309" />
            </div>
            <Cards items={SOLUTION} testid="about-solution-cards" />
          </div>
        </Section>

        <Section id="hardware" eyebrow="Hardware architecture" title="From sensor to dashboard">
          <ol className="about-flow" aria-label="Data flow">
            {[['Sensors', Radio], ['ESP32', Cpu], ['Wi-Fi cloud', Cloud], ['Dashboard', MonitorSmartphone]].map(([label, Icon], i, all) => (
              <li key={label}>
                <span className="about-flow-step"><Icon size={18} aria-hidden="true" />{label}</span>
                {i < all.length - 1 ? <ArrowRight size={16} className="about-flow-arrow dim" aria-hidden="true" /> : null}
              </li>
            ))}
          </ol>
          <PhotoRow items={HARDWARE_PHOTOS} testid="about-hardware-photos" />
          <div className="grid grid-2">
            <div className="panel">
              <div className="panel-head"><h3>Core components</h3></div>
              <ul className="about-list" data-testid="about-components">
                {COMPONENTS.map(({ icon: Icon, name, role, measures }) => (
                  <li key={name}>
                    <Icon size={16} className="about-icon" aria-hidden="true" />
                    <span><strong className="mono">{name}</strong> · {role}<span className="xs dim"> · {measures}</span></span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="panel">
              <div className="panel-head"><h3>Power & communication</h3></div>
              <ul className="about-list">
                <li><BatteryCharging size={16} className="about-icon" aria-hidden="true" /><span>Rechargeable battery with efficient power management</span></li>
                <li><Wifi size={16} className="about-icon" aria-hidden="true" /><span>Onboard Wi-Fi for a seamless cloud uplink</span></li>
                <li><Gauge size={16} className="about-icon" aria-hidden="true" /><span>Designed for long-duration autonomous operation</span></li>
              </ul>
            </div>
          </div>
        </Section>

        <Section id="innovations" eyebrow="Key innovations" title="Why it is different">
          <Cards items={INNOVATIONS} testid="about-innovation-cards" />
        </Section>

        <Section id="comparison" eyebrow="Why it matters" title="Traditional vs. proposed system">
          <PhotoRow items={WHY_PHOTOS} testid="about-why-photos" />
          <div className="panel">
            <table className="data responsive" data-testid="about-comparison-table">
              <thead><tr><th>Criterion</th><th>Manual inspection</th><th>Industrial SHM</th><th>Our solution</th></tr></thead>
              <tbody>
                {COMPARISON.map(([criterion, manual, industrial, ours]) => (
                  <tr key={criterion}>
                    <td data-label="Criterion"><strong>{criterion}</strong></td>
                    <td data-label="Manual inspection">{manual}</td>
                    <td data-label="Industrial SHM">{industrial}</td>
                    <td data-label="Our solution" className="c-nominal">{ours}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">The best balance of cost, functionality and ease of use for small-to-medium infrastructure.</p>
        </Section>

        <Section id="workflow" eyebrow="Implementation workflow" title="Four months from idea to MVP">
          <ol className="about-timeline" data-testid="about-timeline">
            {TIMELINE.map((t, i) => (
              <li key={t.month}>
                <span className="about-step mono">{i + 1}</span>
                <div><strong>{t.month}</strong><p>{t.text}</p></div>
              </li>
            ))}
          </ol>
          <PhotoRow items={TIMELINE_PHOTOS} testid="about-timeline-photos" />
          <div className="grid grid-2">
            <div className="about-card"><h3>Phase 1 · Proof of concept</h3><p>Months 1–2: circuit design, firmware, cloud integration and the PoC demo at Week 8.</p></div>
            <div className="about-card"><h3>Phase 2 · Minimum viable product</h3><p>Months 3–4: PCB fabrication, power optimisation, multi-node testing and the MVP release at Week 16.</p></div>
          </div>
        </Section>

        <Section id="market" eyebrow="Target market & expected outcomes" title="Who it serves">
          <PhotoRow items={SERVE_PHOTOS} testid="about-serve-photos" />
          <div className="grid grid-2">
            <div className="panel">
              <div className="panel-head"><h3>Who it serves</h3></div>
              <ul className="about-list">
                {MARKET.map((m) => <li key={m}><Users size={16} className="about-icon" aria-hidden="true" /><span>{m}</span></li>)}
              </ul>
            </div>
            <div className="about-cards about-cards-stack">
              {OUTCOMES.map((o) => <div key={o.title} className="about-card"><h3>{o.title}</h3><p>{o.text}</p></div>)}
            </div>
          </div>
        </Section>

        <Section id="prototype" eyebrow="This website" title="What the working prototype includes">
          <Cards items={IN_THIS_APP} testid="about-prototype-cards" />
        </Section>

        <section className="about-cta about-cta-photo panel" data-testid="about-cta">
          <MessageCircle size={18} className="about-icon" aria-hidden="true" />
          <p>Thank you for your time. Questions and suggestions are welcome.</p>
          <span className="spacer" />
          {home
            ? <Link to={home} className="btn btn-primary">Open {user.role === 'admin' ? 'dashboard' : 'readings'}</Link>
            : <Link to="/login" className="btn btn-primary">Login to the dashboard</Link>}
        </section>
      </main>
      <ScrollTop />
      {viewing ? <NodeViewer onClose={() => setViewing(false)} /> : null}
    </div>
  )
}
