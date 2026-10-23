import { Route, Routes } from 'react-router-dom';
import { PublicLayout, DashboardLayout } from './components/layout/Layouts';
import { RequireAuth, RequireRole } from './auth/guards';
import { NotFoundState } from './components/ui/states';
import Landing from './pages/Landing';
import Pricing from './pages/Pricing';
import Profile from './pages/Profile';
import { Login, Register, ForgotPassword, ResetPassword } from './pages/authForms';
import { AdminDashboard, MemberDashboard } from './pages/Dashboards';

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
      <Route element={<RequireAuth><DashboardLayout /></RequireAuth>}>
        <Route path="/dashboard" element={<MemberDashboard />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/admin" element={<RequireRole roles={['admin']}><AdminDashboard /></RequireRole>} />
      </Route>
    </Routes>
  );
}
