import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import 'antd/dist/reset.css'
import './console.css'

createRoot(document.getElementById('app')!).render(
  <ConfigProvider locale={zhCN} theme={{
    token: {
      colorPrimary: '#4f46e5', colorText: '#17223a', colorTextSecondary: '#53617a',
      colorBorderSecondary: '#e6eaf3', borderRadius: 8, controlHeight: 36,
      fontFamily: 'Inter, "Microsoft YaHei UI", system-ui, sans-serif',
    },
    components: { Table: { headerBg: '#f6f8fd', headerColor: '#34425e' } },
  }}>
    <App />
  </ConfigProvider>,
)
