thêm các tính năng bổ sung của master:
* thêm trạng thái slave 1, slave 2 đế biết con nào mất kết nối
* Tính năng thêm file: có 2 loại file
    - Thêm file cho vòng loại
    - Thêm file vòng 1-16
    chế độ thi đấu:
        + vòng loại: thi xong sẽ cho xuất file csv ra xắp sếp thứ hạng từ nhất đến thấp nhất. tạo thêm 1 trang cho xem thống kê lượt 1, lượt 2, thời gian tốt nhất luôn.
        + Vòng 1-16: dùng file csv đã sắp sếp ở vòng loại lấy 16 người(1-16, 2-15,... như cũ) nhưng sẽ dùng file csv đã nhập riêng cho vòng 1-16 chứ đừng dùng file của vòng loại. với thêm tính năng nếu cặp đó ko có đối thủ (vd số 1 đấu với số 16 mà số 16 DQ (bỏ cuộc hoặc loại) thì số 1 được vào vòng trong luôn)
    Logic trận đấu:
        + các số ván đấu hiện đang 1 2 3 4 5 bên nào thắng là màu sáng, thua màu tối. hãy thêm ván hiện tại cho số đó sáng trắng lên xíu để biết đang ở ván mấy
        + các ván đâu đều lưu xuống csv số lỗi penalty, thời gian của các vận động viên. Mở thêm tính năng khi ấn lại các số 1 2 3 4 5 là xem lại được luôn, hoặc cho chạy lại ván đó luôn ý chứ không phải chốt xông là không thay đổi được.
        + đổi logic đấu 5 ván thành thi 3 thắng 2 là win tối đa 5 ván cd 3 ván đó mắc lỗi hết thì mới có ván 4 5.
    Logic đếm cảm biến:
        + cho cài đếm dùng salve 1 hoặc slave 2 chứ hiện tại tắt slave 2 là ko đếm dc slave 1 luôn. 
        + thêm nút UP hoặc DW. UP là đếm đến số đang cài còn DW là từ số đang cài về  số 0, có hiệu ứng của nút UP hoặc DW để biết đang ở chế độ nào
    logic đồng hồ đếm ngược, đếm lên:
        + cũng cho phép dùng slave 1 hoặc slave 2 hoặc cả 2 slave cùng đếm.
        + có 3 nút: start, pause, reset. start là bắt đầu đếm từ số trên bảng led, pause dừng lại muốn đếm tiếp từ ấn start, reset là về số đã cài và đứng im chờ bấm lại bắt đầu.
        + đếm ngược đếm từ số đã cài về số 0 rồi đứng im ở số 0
        + đếm lên từ số 0 đến số đã cài rồi đứng im ở số đó
      