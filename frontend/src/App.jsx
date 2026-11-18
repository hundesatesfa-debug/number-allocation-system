import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";
import "./App.css";

const API = "http://localhost:3000";

export default function App() {
  const [session, setSession] = useState(null);
  const [admin, setAdmin] = useState(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rounds, setRounds] = useState([]);
  const [selected, setSelected] = useState("");
  const [available, setAvailable] = useState([]);
  const [allocations, setAllocations] = useState([]);
  const [stats, setStats] = useState({ total: 0, paid: 0, unpaid: 0 });

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [roundName, setRoundName] = useState("");
  const [maxNumber, setMaxNumber] = useState("1000");
  const [participant, setParticipant] = useState({
    full_name: "", phone: "", number: "", payment_status: "unpaid"
  });

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setPageLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  async function api(path, options = {}) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    const response = await fetch(`${API}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...options.headers
      }
    });

    const contentType = response.headers.get("content-type") || "";
    if (!response.ok) {
      const body = contentType.includes("application/json")
        ? await response.json()
        : { error: await response.text() };
      throw new Error(body.error || "Request failed");
    }

    if (contentType.includes("text/csv")) return response.blob();
    return response.json();
  }

  useEffect(() => {
    if (!session) {
      setAdmin(null);
      setRounds([]);
      return;
    }

    loadDashboard();
  }, [session]);

  async function loadDashboard() {
    try {
      setError("");
      const me = await api("/api/me");
      setAdmin(me.admin);
      const data = await api("/api/rounds");
      setRounds(data);
      if (data.length && !selected) setSelected(data[0].id);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    if (selected && session) loadRound(selected);
  }, [selected, session]);

  async function loadRound(id) {
    try {
      const [availableData, allocationData] = await Promise.all([
        api(`/api/rounds/${id}/available`),
        api(`/api/rounds/${id}/allocations`)
      ]);

      setAvailable(availableData.numbers);
      setAllocations(allocationData);

      const active = allocationData.filter(a => a.allocation_status === "allocated");
      setStats({
        total: active.length,
        paid: active.filter(a => a.payment_status === "paid").length,
        unpaid: active.filter(a => a.payment_status === "unpaid").length
      });
    } catch (err) {
      setError(err.message);
    }
  }

  async function login(e) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message);

    setLoading(false);
  }

  async function logout() {
    await supabase.auth.signOut();
    setAdmin(null);
    setSelected("");
  }

  async function createRound(e) {
    e.preventDefault();
    try {
      setLoading(true);
      const round = await api("/api/rounds", {
        method: "POST",
        body: JSON.stringify({ name: roundName, max_number: Number(maxNumber) })
      });
      setRounds(prev => [round, ...prev]);
      setSelected(round.id);
      setRoundName("");
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function changeStatus(status) {
    try {
      setLoading(true);
      const updated = await api(`/api/rounds/${selected}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status })
      });
      setRounds(prev => prev.map(r => r.id === selected ? updated : r));
      await loadRound(selected);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function registerParticipant(e) {
    e.preventDefault();

    if (!selected) return;

    try {
      setLoading(true);
      setError("");

      const numberToRemove = Number(participant.number);

      await api(`/api/rounds/${selected}/allocations`, {
        method: "POST",
        body: JSON.stringify(participant)
      });

      // Immediately remove the newly allocated number from the visible pool.
      setAvailable(prev => prev.filter(n => n !== numberToRemove));

      setParticipant({
        full_name: "", phone: "", number: "", payment_status: "unpaid"
      });

      // Refresh registrations, available numbers, and statistics.
      await loadRound(selected);

    } catch (err) {
      setError(err.message);
      await loadRound(selected);
    } finally {
      setLoading(false);
    }
  }

  async function updatePayment(id, payment_status) {
    try {
      await api(`/api/allocations/${id}/payment`, {
        method: "PATCH",
        body: JSON.stringify({ payment_status })
      });
      await loadRound(selected);
    } catch (err) {
      setError(err.message);
    }
  }

  async function cancelAllocation(id) {
    if (!confirm("Cancel this allocation? The number will become available again.")) return;
    try {
      await api(`/api/allocations/${id}/cancel`, { method: "PATCH" });
      await loadRound(selected);
    } catch (err) {
      setError(err.message);
    }
  }

  async function downloadReport() {
    try {
      const blob = await api(`/api/rounds/${selected}/report.csv`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "round-report.csv";
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    }
  }

  if (pageLoading) return <div className="loading-screen">Loading NumberFlow...</div>;

  if (!session) {
    return (
      <main className="login-page">
        <div className="login-decoration"></div>
        <section className="login-card">
          <div className="brand-mark">N</div>
          <p className="eyebrow">NUMBER MANAGEMENT PLATFORM</p>
          <h1>Welcome back.</h1>
          <p className="muted">Sign in to manage your number allocation rounds.</p>
          {error && <div className="alert">{error}</div>}
          <form onSubmit={login}>
            <label>Email address</label>
            <input type="email" placeholder="admin@example.com" value={email}
              onChange={e => setEmail(e.target.value)} required />
            <label>Password</label>
            <input type="password" placeholder="Your password" value={password}
              onChange={e => setPassword(e.target.value)} required />
            <button className="primary-button full" disabled={loading}>
              {loading ? "Signing in..." : "Sign in to dashboard"}
            </button>
          </form>
          <p className="login-foot">Authorized administrators only</p>
        </section>
      </main>
    );
  }

  if (session && !admin && !error) {
    return <div className="loading-screen">Verifying administrator access...</div>;
  }

  if (session && error && !admin) {
    return (
      <div className="login-page">
        <section className="login-card">
          <div className="brand-mark">N</div>
          <h1>Access unavailable</h1>
          <div className="alert">{error}</div>
          <button className="primary-button full" onClick={logout}>Sign out</button>
        </section>
      </div>
    );
  }

  const currentRound = rounds.find(r => r.id === selected);
  const activeAllocations = allocations.filter(a => a.allocation_status === "allocated");

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark small">N</div>
          <div><strong>NumberFlow</strong><span>ALLOCATION SYSTEM</span></div>
        </div>

        <div className="side-label">WORKSPACE</div>
        <button className="nav-item selected"><span>?</span> Dashboard</button>
        <button className="nav-item" onClick={() => document.getElementById("rounds")?.scrollIntoView({ behavior: "smooth" })}><span>?</span> Rounds</button>
        <button className="nav-item" onClick={() => document.getElementById("registrations")?.scrollIntoView({ behavior: "smooth" })}><span>?</span> Registrations</button>

        <div className="sidebar-bottom">
          <div className="profile">
            <div className="avatar">{(admin?.full_name || "A").charAt(0).toUpperCase()}</div>
            <div className="profile-info">
              <strong>{admin?.full_name || "Administrator"}</strong>
              <span>{admin?.role || "admin"}</span>
            </div>
          </div>
          <button className="logout-button" onClick={logout}>? Sign out</button>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <p className="eyebrow">MANAGEMENT / OVERVIEW</p>
            <h1>Dashboard</h1>
          </div>
          <div className="topbar-right">
            <span className="online-dot"></span>
            <span>System online</span>
            <button className="icon-button" onClick={loadDashboard} title="Refresh">?</button>
          </div>
        </header>

        {error && <div className="alert page-alert">{error}<button onClick={() => setError("")}>×</button></div>}

        <section className="welcome-row">
          <div>
            <h2>Good to see you, {admin?.full_name?.split(" ")[0] || "Admin"}.</h2>
            <p>Here's what's happening with your allocation system.</p>
          </div>
          <span className="date-chip">{new Date().toLocaleDateString()}</span>
        </section>

        <section className="stats-grid">
          <div className="stat-card">
            <div className="stat-top"><span>Total allocated</span><span className="stat-icon purple">?</span></div>
            <strong>{stats.total}</strong><small>In selected round</small>
          </div>
          <div className="stat-card">
            <div className="stat-top"><span>Paid numbers</span><span className="stat-icon green">?</span></div>
            <strong>{stats.paid}</strong><small>Payment confirmed</small>
          </div>
          <div className="stat-card">
            <div className="stat-top"><span>Unpaid numbers</span><span className="stat-icon orange">?</span></div>
            <strong>{stats.unpaid}</strong><small>Awaiting payment</small>
          </div>
          <div className="stat-card">
            <div className="stat-top"><span>Available numbers</span><span className="stat-icon blue">#</span></div>
            <strong>{available.length}</strong><small>Ready for allocation</small>
          </div>
        </section>

        <section className="panel" id="rounds">
          <div className="panel-heading">
            <div><p className="eyebrow">ROUND MANAGEMENT</p><h2>Your rounds</h2></div>
            <span className="count-chip">{rounds.length} rounds</span>
          </div>

          <form className="create-round" onSubmit={createRound}>
            <input value={roundName} onChange={e => setRoundName(e.target.value)}
              placeholder="New round name" required />
            <input type="number" min="1" max="100000" value={maxNumber}
              onChange={e => setMaxNumber(e.target.value)} required />
            <button className="primary-button" disabled={loading}>+ Create round</button>
          </form>

          <div className="round-list">
            {rounds.length === 0 && <p className="empty-state">No rounds yet. Create your first round above.</p>}
            {rounds.map(round => (
              <button key={round.id}
                className={`round-item ${selected === round.id ? "active-round" : ""}`}
                onClick={() => setSelected(round.id)}>
                <span className="round-symbol">#</span>
                <span className="round-info"><strong>{round.name}</strong><small>Numbers 1–{round.max_number}</small></span>
                <span className={`status ${round.status}`}>{round.status}</span>
                <span className="round-arrow">›</span>
              </button>
            ))}
          </div>
        </section>

        {currentRound && (
          <>
            <section className="panel round-control">
              <div>
                <p className="eyebrow">SELECTED ROUND</p>
                <h2>{currentRound.name}</h2>
                <p className="muted">Number range: 1 to {currentRound.max_number}</p>
              </div>
              <div className="round-actions">
                {currentRound.status === "draft" && <button className="primary-button" onClick={() => changeStatus("active")}>Activate round</button>}
                {currentRound.status === "active" && <button className="secondary-button" onClick={() => changeStatus("paused")}>Pause round</button>}
                {currentRound.status === "paused" && <button className="primary-button" onClick={() => changeStatus("active")}>Resume round</button>}
                {(currentRound.status === "active" || currentRound.status === "paused") &&
                  <button className="danger-button" onClick={() => changeStatus("closed")}>Close round</button>}
                <button className="secondary-button" onClick={downloadReport}>? Export CSV</button>
              </div>
            </section>

            <section className="workspace-grid">
              <div className="panel" id="registrations">
                <div className="panel-heading">
                  <div><p className="eyebrow">NEW ENTRY</p><h2>Register participant</h2></div>
                </div>
                <form className="register-form" onSubmit={registerParticipant}>
                  <label>Participant name</label>
                  <input placeholder="Full name" value={participant.full_name}
                    onChange={e => setParticipant({ ...participant, full_name: e.target.value })} required />
                  <label>Phone number</label>
                  <input placeholder="+251..." value={participant.phone}
                    onChange={e => setParticipant({ ...participant, phone: e.target.value })} />
                  <div className="form-two">
                    <div><label>Choose number</label>
                      <input type="number" min="1" max={currentRound.max_number}
                        placeholder="e.g. 25" value={participant.number}
                        onChange={e => setParticipant({ ...participant, number: e.target.value })} required /></div>
                    <div><label>Payment</label>
                      <select value={participant.payment_status}
                        onChange={e => setParticipant({ ...participant, payment_status: e.target.value })}>
                        <option value="unpaid">Unpaid</option><option value="paid">Paid</option>
                      </select></div>
                  </div>
                  <button className="primary-button full" disabled={loading || currentRound.status !== "active"}>
                    {currentRound.status === "active" ? "Register number" : "Activate round to register"}
                  </button>
                </form>
              </div>

              <div className="panel available-panel">
                <div className="panel-heading">
                  <div><p className="eyebrow">LIVE NUMBER POOL</p><h2>Available numbers</h2></div>
                  <span className="count-chip">{available.length} left</span>
                </div>
                <p className="muted">Numbers not currently allocated in this round.</p>
                <div className="number-grid">
                  {available.slice(0, 120).map(number => (
                    <button key={number} className="number-chip"
                      onClick={() => setParticipant(p => ({ ...p, number: String(number) }))}>
                      {number}
                    </button>
                  ))}
                </div>
                {available.length > 120 && <p className="muted">Showing first 120 numbers. Select a number by typing it in the form.</p>}
                {available.length === 0 && <p className="empty-state">No available numbers.</p>}
              </div>
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div><p className="eyebrow">ROUND RECORDS</p><h2>Allocations</h2></div>
                <span className="count-chip">{activeAllocations.length} records</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>NUMBER</th><th>PARTICIPANT</th><th>PHONE</th><th>PAYMENT</th><th>ACTION</th></tr></thead>
                  <tbody>
                    {activeAllocations.map(item => (
                      <tr key={item.id}>
                        <td><strong className="number-cell">#{item.number}</strong></td>
                        <td>{item.participants?.full_name || "—"}</td>
                        <td>{item.participants?.phone || "—"}</td>
                        <td><button className={`payment-pill ${item.payment_status}`}
                          onClick={() => updatePayment(item.id, item.payment_status === "paid" ? "unpaid" : "paid")}>
                          {item.payment_status}
                        </button></td>
                        <td><button className="cancel-button" onClick={() => cancelAllocation(item.id)}>Cancel</button></td>
                      </tr>
                    ))}
                    {activeAllocations.length === 0 && <tr><td colSpan="5" className="empty-state">No allocations in this round yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
        <footer>NumberFlow · Number Allocation Management</footer>
      </main>
    </div>
  );
}


