import { Route, Routes } from 'react-router-dom';
import { AdaptiveLayout, PublicLayout, DashboardLayout } from './components/layout/Layouts';
import { RequireAuth, RequireRole } from './auth/guards';
import { NotFoundState } from './components/ui/states';
import Landing from './pages/Landing';
import Pricing from './pages/Pricing';
import Profile from './pages/Profile';
import { Login, Register, ForgotPassword, ResetPassword } from './pages/authForms';
import { AdminDashboard, MemberDashboard } from './pages/Dashboards';
import Signals from './pages/Signals';
import SignalDetail from './pages/SignalDetail';
import Saved from './pages/Saved';
import Settings from './pages/Settings';
import { AdminSignalEdit, AdminSignalNew } from './pages/AdminSignals';

export default function App() {
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route path="/" element={<Landing />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="*" element={<NotFoundState />} />
      </Route>
      <Route element={<AdaptiveLayout />}>
        <Route path="/signals" element={<Signals />} />
        <Route path="/signals/:id" element={<SignalDetail />} />
      </Route>
      <Route element={<RequireAuth><DashboardLayout /></RequireAuth>}>
        <Route path="/saved" element={<Saved />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/admin/signals/new" element={<RequireRole roles={['admin']}><AdminSignalNew /></RequireRole>} />
        <Route path="/admin/signals/:id/edit" element={<RequireRole roles={['admin']}><AdminSignalEdit /></RequireRole>} />
        <Route path="/dashboard" element={<MemberDashboard />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/admin" element={<RequireRole roles={['admin']}><AdminDashboard /></RequireRole>} />
      </Route>
    </Routes>
  );
}
