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
import Checkout from './pages/Checkout';
import PaymentStatus from './pages/PaymentStatus';
import Billing from './pages/Billing';
import Receipt from './pages/Receipt';
import AdminBilling from './pages/AdminBilling';
import AdminPlans from './pages/AdminPlans';
import Rooms from './pages/Rooms';
import RoomDetail from './pages/RoomDetail';
import StaffRooms from './pages/StaffRooms';
import StaffRoomEdit from './pages/StaffRoomEdit';

export default function App() {
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="*" element={<NotFoundState />} />
      </Route>
      <Route element={<AdaptiveLayout />}>
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/signals" element={<Signals />} />
        <Route path="/signals/:id" element={<SignalDetail />} />
        <Route path="/rooms" element={<Rooms />} />
        <Route path="/rooms/:slug" element={<RoomDetail />} />
      </Route>
      <Route element={<RequireAuth><DashboardLayout /></RequireAuth>}>
        <Route path="/saved" element={<Saved />} />
        <Route path="/checkout/:planCode" element={<Checkout />} />
        <Route path="/billing" element={<Billing />} />
        <Route path="/billing/payments/:id" element={<PaymentStatus />} />
        <Route path="/billing/invoices/:id" element={<Receipt />} />
        <Route path="/admin/billing" element={<RequireRole roles={['admin']}><AdminBilling /></RequireRole>} />
        <Route path="/admin/plans" element={<RequireRole roles={['admin']}><AdminPlans /></RequireRole>} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/staff/rooms" element={<RequireRole roles={['moderator', 'admin']}><StaffRooms /></RequireRole>} />
        <Route path="/staff/rooms/new" element={<RequireRole roles={['moderator', 'admin']}><StaffRoomEdit /></RequireRole>} />
        <Route path="/staff/rooms/:id/edit" element={<RequireRole roles={['moderator', 'admin']}><StaffRoomEdit /></RequireRole>} />
        <Route path="/admin/signals/new" element={<RequireRole roles={['admin']}><AdminSignalNew /></RequireRole>} />
        <Route path="/admin/signals/:id/edit" element={<RequireRole roles={['admin']}><AdminSignalEdit /></RequireRole>} />
        <Route path="/dashboard" element={<MemberDashboard />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/admin" element={<RequireRole roles={['admin']}><AdminDashboard /></RequireRole>} />
      </Route>
    </Routes>
  );
}
